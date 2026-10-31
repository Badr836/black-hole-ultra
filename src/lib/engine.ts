import { spawn, type ChildProcess } from "node:child_process";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { db } from "@/db";
import { downloads, type Download, type DownloadStatus, type Settings } from "@/db/schema";
import { resolveBinary } from "./binaries";
import { getSettings } from "./settings";
import { needsFfmpeg, noFfmpegSelector } from "./format-selector";
import { impersonationCaps, siteOptions, friendlyDownloadError } from "./site-options";
import { commonDownloadOptions } from "./download-options";
import { JobWriter, type WriterPatch } from "./job-writer";
import { extractFfmpegError, extractYtDlpError, redactLog } from "./log-redact";
import { allowedRoots, isInsideAnyRoot, safeReal } from "./safe-path";
import { runBinary } from "./binaries";
import { isRateLimitMessage, routeProvider, shouldTryFallback, type RouteResult } from "./providers";
import { getJsRuntimes, jsRuntimeArgs, pickJsRuntime } from "./runtimes";
import { buildHeaderCandidates, describeProbe, pickWorkingHeaders } from "./site-session";
import {
  buildCookieHeader,
  buildNm3u8dlArgs,
  DRM_REFUSAL_MESSAGE,
  parseHeaderLines,
  resolveAudioLanguage,
  friendlyHlsError,
  isHlsUrl,
  isOutputFileFor,
  isPermanentHlsFailure,
  looksLikeDrmFailure,
  looksLikeDrmManifest,
  overallHlsPercent,
  parseNm3u8dlProgress,
  safeSaveName,
  updateHlsTracks,
  type HlsTrackState,
} from "./hls";
import {
  canRetryIncomplete,
  computeMissingEntries,
  MAX_INCOMPLETE_RETRIES,
  playlistSpecToIndices as playlistSpecToIndicesLocal,
  incompleteSummary,
  parseFileMarker,
  parsePlaylistItemMarker,
  playlistTotalFromOutput,
  retrySpecFor,
  type MissingEntry,
  type PlaylistItem,
} from "./playlist";
import {
  COOKIE_PERMISSION_MESSAGE,
  parseAria2Progress,
  parseDestinationMarker,
  downloadArchiveArgs,
  externalDownloaderArgs,
  isArchiveSkip,
  isCookiePermissionError,
  skipCompletionNote,
  isYouTubeUrl,
  looksLikeDashOrHls,
  parsePlaylistSpecCount,
  playlistCompletionNote,
  playlistTotalFromLog,
  shouldRotateYouTubeClient,
  sponsorBlockArgs,
  youTubeClientArgs,
} from "./yt-policy";

/**
 * In-process download engine.
 *
 * Design guarantees (see docs/agents/03-hakam-judge.md):
 *  1. A queued row is claimed with a compare-and-swap UPDATE, so two server
 *     instances (or two dev workers) can never start the same job twice.
 *  2. All writes for a job go through a serialised `JobWriter`, so a progress
 *     write can never land after `completed`.
 *  3. FFmpeg is required only when the job actually needs post-processing.
 *  4. Every produced file is recorded, not just the last one.
 */

/** Kill a job that stopped producing output (stuck HTTP, dead extractor…). */
const IDLE_TIMEOUT_MS = Number(process.env.BLACKHOLE_IDLE_TIMEOUT_MS ?? 5 * 60 * 1000);

type Job = {
  id: number;
  proc: ChildProcess;
  pausedByUser: boolean;
  cancelled: boolean;
  timedOut: boolean;
  rateLimited: boolean;
  lastActivity: number;
  writer: JobWriter<WriterPatch>;
  lastDbWrite: number;
  finalPaths: string[];
  /** Files yt-dlp announced via "Destination:" — used to poll .part growth. */
  destinations: string[];
  log: string[];
  probeFailed: boolean;
  /** Only set for jobs using an external downloader (no native progress). */
  progressPoller: NodeJS.Timeout | null;
  lastPolledBytes: number;
  /** Highest percentage reported natively (keeps byte-polls monotonic). */
  progressFloor: number;
  /** Sum of expected byte sizes from BHDEST markers (playlists add up). */
  expectedTotal: number;
  /** BHITEM markers: which playlist entry is being handled right now. */
  items: PlaylistItem[];
  /** BHFILE markers: ids that actually produced a file. */
  producedIds: string[];
  /** Current playlist entry (1-based) and total, from yt-dlp's own lines. */
  itemIndex: number;
  playlistTotal: number;
  /** HLS track bookkeeping (the tool downloads tracks sequentially). */
  hlsTracks: HlsTrackState;
  /** A 404/403 that will never succeed on retry — stop early, report once. */
  permanentFailure: boolean;
  externalDownloader: boolean;
};

class DownloadEngine {
  private jobs = new Map<number, Job>();
  private ticking = false;
  private pumpTimer: NodeJS.Timeout | null = null;

  private watchdog: NodeJS.Timeout | null = null;

  constructor() {
    void this.recoverOnBoot();
    this.watchdog = setInterval(() => this.checkIdle(), 30_000);
    this.watchdog.unref?.();
  }

  /**
   * A stuck process used to leave a row at "downloading" forever with a live
   * child process. Now silence for IDLE_TIMEOUT_MS kills it and reports why.
   */
  private checkIdle() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.pausedByUser || job.cancelled) continue;
      if (now - job.lastActivity < IDLE_TIMEOUT_MS) continue;
      job.timedOut = true;
      killProc(job.proc);
    }
  }

  private async recoverOnBoot() {
    try {
      // Rows left mid-flight by a crash/restart return to "paused" — never stay
      // "downloading" forever with no process behind them.
      await db
        .update(downloads)
        .set({ status: "paused", speed: null, eta: null, updatedAt: new Date() })
        .where(inArray(downloads.status, ["downloading", "converting"]));

      const completed = await db
        .select({ id: downloads.id, filePath: downloads.filePath })
        .from(downloads)
        .where(eq(downloads.status, "completed"));
      for (const item of completed) {
        if (!item.filePath || !existsSync(item.filePath)) {
          await db
            .update(downloads)
            .set({
              status: "missing",
              error: "الملف المكتمل لم يعد موجوداً في مسار الحفظ. يمكنك إعادة تنزيله أو حذفه من السجل.",
              updatedAt: new Date(),
            })
            .where(eq(downloads.id, item.id));
        }
      }
    } catch {
      /* database may not be reachable yet */
    }
    this.schedulePump();
  }

  schedulePump() {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      void this.pump();
    }, 50);
  }

  async pump() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const s = await getSettings();
      const free = Math.max(0, s.maxConcurrent - this.jobs.size);
      if (free === 0) return;
      const queued = await db
        .select()
        .from(downloads)
        .where(eq(downloads.status, "queued"))
        .orderBy(asc(downloads.createdAt))
        .limit(free);
      for (const row of queued) {
        if (!this.jobs.has(row.id)) await this.start(row);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Compare-and-swap claim: only one caller can move queued → downloading. */
  private claim(id: number, provider?: "ytdlp" | "gallerydl" | "nm3u8dl"): boolean {
    const result = db
      .update(downloads)
      .set({
        ...(provider ? { provider } : {}),
        status: "downloading",
        error: null,
        log: null,
        speed: null,
        eta: null,
        progress: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(downloads.id, id), eq(downloads.status, "queued")))
      .run();
    return result.changes === 1;
  }

  private makeWriter(id: number): JobWriter<WriterPatch> {
    return new JobWriter<WriterPatch>(
      (patch) => {
        const { id: _id, createdAt: _createdAt, ...rest } = patch as Record<string, unknown> & {
          id?: number;
          createdAt?: Date;
        };
        void _id;
        void _createdAt;
        db.update(downloads)
          .set({ ...rest, updatedAt: new Date() })
          .where(eq(downloads.id, id))
          .run();
      },
      {
        onError: (error) => {
          console.error(
            `[blackhole] failed to persist state for download #${id}:`,
            error instanceof Error ? error.message : error,
          );
        },
      },
    );
  }

  private buildArgs(
    d: Download,
    s: Settings,
    tools: { ffmpeg: string | null; ffprobe: string | null; aria2c: string | null },
    compat: { impersonate: boolean; profiles: string[]; jsRuntimeArgs: string[] },
  ): string[] {
    const metadata = (d.metadata ?? {}) as Record<string, unknown>;
    const ytClient = typeof metadata.ytClient === "string" ? metadata.ytClient : null;
    const external = externalDownloaderArgs(s.externalDownloader, tools.aria2c, {
      isDashOrHls: looksLikeDashOrHls(d.formatSelector, d.container),
    });
    const args: string[] = [
      "--newline",
      "--progress",
      "--no-warnings",
      ...(s.allowInsecureTls ? ["--no-check-certificates"] : []),
      ...commonDownloadOptions(s),
      "--continue",
      "--no-overwrites",
      "--retries",
      "5",
      "--fragment-retries",
      "10",
      "--concurrent-fragments",
      String(s.concurrentFragments ?? 4),
      "--windows-filenames",
      // --print implies --quiet; we need yt-dlp's own lines back (per-entry
      // errors, "Downloading item N of M", skip notices) to verify a playlist.
      "--no-quiet",
      "--print",
      // Quiet mode hides "Destination:"; this marker carries it (plus size).
      "before_dl:BHDEST:%(filename)s|%(filesize,filesize_approx)s",
      "--print",
      // `playlist:` prints once for the playlist itself (index = NA); `before_dl`
      // prints once per entry and gives us the real index.
      "before_dl:BHITEM:%(playlist_index)s|%(id)s",
      "--print",
      "after_move:BHFILE:%(id)s|%(filepath)s",
      "--print",
      "after_move:filepath",
      "-o",
      path.join(d.outputDir, s.fileNameTemplate),
      "--progress-template",
      "download:[BH]%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s",
      ...siteOptions(d.url, d.retries, {
        impersonate: compat.impersonate,
        availableProfiles: compat.profiles,
      }),
      // JS runtime: only when a *supported* one exists (yt-dlp #15012).
      ...compat.jsRuntimeArgs,
      // Player-client override, set only after a previous failure.
      ...youTubeClientArgs(ytClient),
      ...sponsorBlockArgs(s.sponsorBlock, isYouTubeUrl(d.url)),
      // Dedupe: media already recorded in this folder's archive is skipped.
      ...downloadArchiveArgs(s.downloadArchive, d.outputDir),
      // aria2c for plain http(s) only; DASH/HLS stay on yt-dlp's downloader.
      ...external,
    ];

    if (s.speedLimit) args.push("--limit-rate", s.speedLimit);
    args.push(d.playlist ? "--yes-playlist" : "--no-playlist");
    if (d.playlist && d.playlistItems) args.push("--playlist-items", d.playlistItems);

    const canPostProcess = Boolean(tools.ffmpeg && tools.ffprobe);

    if (!canPostProcess) {
      // Graceful degradation: single-file formats only, no merge/remux/convert.
      const quality = d.qualityLabel.endsWith("p") ? d.qualityLabel.slice(0, -1) : "best";
      args.push("-f", noFfmpegSelector(d.kind, quality));
      args.push(d.url);
      return args;
    }

    if (d.kind === "audio") {
      args.push("-f", d.formatSelector || "bestaudio/best");
      // yt-dlp has no WMA output preset: extract to WAV, convert with FFmpeg after.
      args.push(
        "-x",
        "--audio-format",
        d.container === "wma" ? "wav" : d.container,
        "--audio-quality",
        "0",
      );
    } else {
      args.push("-f", d.formatSelector);
      args.push("--merge-output-format", d.container);
      if (d.container !== "webm" && d.formatSelector.includes("+")) {
        args.push("--remux-video", d.container);
      }
    }
    if (s.embedMetadata) args.push("--embed-metadata");
    if (s.embedThumbnail && ["mp4", "mkv", "mp3", "m4a", "flac", "opus"].includes(d.container)) {
      args.push("--embed-thumbnail");
    }
    if (d.subtitles) {
      args.push("--write-subs", "--write-auto-subs", "--sub-langs", "ar,en,-live_chat");
      if (d.kind === "video" && ["mp4", "mkv", "webm"].includes(d.container)) args.push("--embed-subs");
    }
    args.push(d.url);
    return args;
  }

  async start(d: Download) {
    const s = await getSettings();
    const ytdlp = resolveBinary("yt-dlp", s.ytdlpPath);
    if (!ytdlp) {
      await this.failBeforeStart(d.id, "yt-dlp غير موجود. ثبّته أو ضعه في مجلد bin/ أو حدّد مساره في الإعدادات.", null);
      return;
    }

    const gallerydl = resolveBinary("gallery-dl", s.gallerydlPath);
    const aria2c = s.externalDownloader === "aria2c" ? resolveBinary("aria2c", null) : null;
    const ffmpeg = resolveBinary("ffmpeg", s.ffmpegPath);
    const siblingFfprobe = ffmpeg
      ? path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
      : null;
    const ffprobe = resolveBinary("ffprobe", siblingFfprobe);

    // Route the URL to the engine that can actually handle it. An explicit
    // provider stored on the row (e.g. after a fallback retry) wins.
    const nm3u8dl = resolveBinary("N_m3u8DL-RE", null);
    const route = routeProvider(
      d.url,
      { ytdlp: Boolean(ytdlp), gallerydl: Boolean(gallerydl), nm3u8dl: Boolean(nm3u8dl) },
      d.provider === "nm3u8dl" || s.providerPreference === "nm3u8dl"
        ? "nm3u8dl"
        : (d.provider ?? s.providerPreference) === "gallerydl"
          ? "gallerydl"
          : "auto",
    );

    if (route.provider === "gallerydl" && gallerydl) {
      await this.startGalleryDl(d, s, gallerydl, route);
      return;
    }

    // HLS engine: only for real .m3u8 links, and only when the user chose it
    // (or a previous yt-dlp attempt handed the job over).
    if (route.provider === "nm3u8dl" && nm3u8dl) {
      if (!isHlsUrl(d.url)) {
        await this.failBeforeStart(
          d.id,
          "مزوّد N_m3u8DL-RE يعمل على روابط m3u8 فقط. اختر «تلقائي» أو yt-dlp لهذا الرابط.",
          null,
        );
        return;
      }
      await this.startNm3u8dl(d, s, nm3u8dl, ffmpeg, route);
      return;
    }

    const needsTools = needsFfmpeg({
      kind: d.kind,
      container: d.container,
      selector: d.formatSelector,
      subtitles: d.subtitles,
    });

    if (needsTools && (!ffmpeg || !ffprobe)) {
      await this.failBeforeStart(
        d.id,
        !ffmpeg
          ? "FFmpeg غير موجود. هذه المهمة تحتاج دمج/تحويل. ثبّت ffmpeg وffprobe أو حدّد مسارهما من الإعدادات."
          : "FFprobe غير موجود بجانب FFmpeg أو في PATH. يلزم ffprobe للدمج والتحويل وفحص الملفات.",
        null,
      );
      return;
    }

    let outputCheck;
    try {
      outputCheck = mkdirSync(d.outputDir, { recursive: true });
      void outputCheck;
    } catch (error) {
      await this.failBeforeStart(
        d.id,
        `تعذّر إنشاء مجلد الحفظ: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
      return;
    }

    // Atomic claim — if another worker grabbed this row, do nothing.
    if (!this.claim(d.id, "ytdlp")) return;

    const impersonate = await impersonationCaps(() => runBinary(ytdlp, ["--list-impersonate-targets"], { timeoutMs: 15_000 }).then((r) => `${r.stdout}\n${r.stderr}`));

    const runtimes = await getJsRuntimes();
    const jsArgs = jsRuntimeArgs(pickJsRuntime(runtimes), s.jsRuntimePath);

    const args = this.buildArgs(
      d,
      s,
      { ffmpeg, ffprobe, aria2c },
      { impersonate: impersonate.supported, profiles: impersonate.targets, jsRuntimeArgs: jsArgs },
    );

    const toolPath = [ffmpeg && path.dirname(ffmpeg), ffprobe && path.dirname(ffprobe), process.env.PATH ?? ""]
      .filter((value): value is string => Boolean(value))
      .join(path.delimiter);

    let proc: ChildProcess;
    try {
      proc = spawn(ytdlp, args, {
        windowsHide: true,
        env: { ...process.env, PATH: toolPath },
      });
    } catch (error) {
      await this.failBeforeStart(
        d.id,
        `تعذّر تشغيل yt-dlp: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
      return;
    }

    const job: Job = {
      id: d.id,
      proc,
      pausedByUser: false,
      cancelled: false,
      timedOut: false,
      rateLimited: false,
      lastActivity: Date.now(),
      writer: this.makeWriter(d.id),
      lastDbWrite: 0,
      finalPaths: [],
      destinations: [],
      log: [],
      probeFailed: false,
      progressPoller: null,
      lastPolledBytes: 0,
      progressFloor: 0,
      expectedTotal: 0,
      items: [],
      producedIds: [],
      itemIndex: 0,
      playlistTotal: 0,
      hlsTracks: { tracks: 0, started: 0, counting: false },
      permanentFailure: false,
      externalDownloader: args.includes("--downloader"),
    };
    this.jobs.set(d.id, job);

    const handleLine = (line: string) => {
      const text = line.trim();
      if (!text) return;

      // Instagram/Reddit answer 429 and the engines then sleep ~1 minute per
      // retry. Fail fast with a precise reason instead of hanging.
      if (isRateLimitMessage(text) && !job.rateLimited) {
        job.rateLimited = true;
        job.log.push(text);
        killProc(job.proc);
        return;
      }

      if (text.startsWith("[BH]")) {
        const [status, dlBytes, total, totalEst, speed, eta, fragIdx, fragCount] = text.slice(4).split("|");
        const downloaded = Number(dlBytes) || 0;
        const totalN = Number(total) || Number(totalEst) || 0;
        let progress = totalN > 0 ? (downloaded / totalN) * 100 : 0;
        if (!totalN && Number(fragCount) > 0) progress = (Number(fragIdx) / Number(fragCount)) * 100;
        if (Number.isFinite(progress) && progress > job.progressFloor) job.progressFloor = progress;
        // A playlist must report overall progress (file i of N), not 0→100 per
        // item — otherwise the bar looks stuck or finished after the first one.
        let reported = Number.isFinite(progress) ? progress : 0;
        if (job.playlistTotal > 1 && job.itemIndex > 0) {
          reported = ((job.itemIndex - 1) + reported / 100) / job.playlistTotal * 100;
        }
        const now = Date.now();
        if (status === "finished" || now - job.lastDbWrite > 500) {
          job.lastDbWrite = now;
          void job.writer.enqueue({
            status: "downloading",
            progress: Math.min(99.9, reported),
            downloadedBytes: downloaded,
            totalBytes: totalN || null,
            speed: speed && speed !== "NA" ? fmtSpeed(Number(speed)) : null,
            eta: eta && eta !== "NA" ? fmtEta(Number(eta)) : null,
          });
        }
        return;
      }

      if (/^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|EmbedThumbnail|Metadata|EmbedSubtitle|FixupM3u8)\]/.test(text)) {
        void job.writer.enqueue({ status: "converting", speed: null, eta: null, progress: 99.9 });
        return;
      }

      const itemMarker = parsePlaylistItemMarker(text);
      if (itemMarker) {
        const existing = job.items.findIndex((item) => item.index === itemMarker.index);
        if (existing >= 0) job.items[existing] = itemMarker;
        else job.items.push(itemMarker);
        return;
      }
      const fileMarker = parseFileMarker(text);
      if (fileMarker) {
        if (!job.finalPaths.includes(fileMarker.path)) job.finalPaths.push(fileMarker.path);
        if (fileMarker.id && !job.producedIds.includes(fileMarker.id)) job.producedIds.push(fileMarker.id);
        return;
      }
      const marker = parseDestinationMarker(text);
      if (marker) {
        if (!job.destinations.includes(marker.path)) {
          job.destinations.push(marker.path);
          job.expectedTotal += marker.size;
        }
        return;
      }
      if (text.startsWith("[download] Destination: ")) {
        const dest = text.slice("[download] Destination: ".length).trim();
        if (dest && !job.destinations.includes(dest)) job.destinations.push(dest);
        return;
      }
      if (isArchiveSkip(text)) {
        job.log.push(text);
        return;
      }
      const itemLine = text.match(/Downloading item (\d+) of (\d+)/);
      if (itemLine) {
        job.itemIndex = Number(itemLine[1]);
        job.playlistTotal = Number(itemLine[2]);
        job.log.push(text);
        if (job.log.length > 200) job.log.shift();
        if (job.playlistTotal > 1) {
          // Move the bar to the start of this entry; otherwise it sits at 99.9%
          // (from the previous item's merge) while the next one downloads.
          void job.writer.enqueue({
            status: "downloading",
            progress: Math.min(99.9, ((job.itemIndex - 1) / job.playlistTotal) * 100),
            speed: null,
            eta: null,
          });
        }
        return;
      }

      if (/^WARNING|^ERROR/.test(text) || /^\[[a-zA-Z]+\]\s/.test(text)) {
        job.log.push(text);
        if (job.log.length > 200) job.log.shift();
        return;
      }

      // after_move:filepath → absolute path of a finished file (one per entry).
      if (path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
        if (!job.finalPaths.includes(text)) job.finalPaths.push(text);
      }
    };

    let lineBuf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      job.lastActivity = Date.now();
      lineBuf += chunk.toString();
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() ?? "";
      lines.forEach(handleLine);
    });
    proc.stderr?.on("data", (chunk: Buffer) => this.noteStderr(job, chunk));

    proc.on("error", (error) => {
      job.probeFailed = true;
      job.log.push(`spawn error: ${error.message}`);
    });

    if (job.externalDownloader) {
      // Transparency: the job log must say which downloader ran.
      job.log.push("[blackhole] المنزّل الخارجي: aria2c (بروتوكول http فقط — DASH/HLS يبقى داخلياً)");
      this.trackExternalProgress(job, d.outputDir);
    }

    proc.on("close", (code) => {
      if (lineBuf) handleLine(lineBuf);
      void this.finish(d, job, code);
    });
  }

  /**
   * With `--downloader http:aria2c`, yt-dlp prints no incremental progress —
   * only "Destination:" and one final "100%" line. Left alone the UI looks
   * frozen for minutes (the exact complaint Motrix/Gopeed users make about
   * other tools), so we poll the `.part` file ourselves.
   */
  private trackExternalProgress(job: Job, outputDir: string) {
    if (job.progressPoller) return;
    job.progressPoller = setInterval(() => {
      if (job.destinations.length === 0) return;

      // The before_dl marker names the *final* file, while yt-dlp/aria2c write
      // "<base>.<format>.<ext>.part" per stream — so match by base prefix.
      const prefixes = job.destinations
        .map((dest) => path.basename(dest).replace(/\.[^.]+$/, ""))
        .filter(Boolean);
      if (prefixes.length === 0) return;

      let bytes = 0;
      try {
        for (const entry of readdirSync(outputDir)) {
          if (!entry.endsWith(".part")) continue; // skips .part.aria2 control files
          if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue;
          try {
            bytes += statSync(path.join(outputDir, entry)).size;
          } catch {
            /* renamed between readdir and stat */
          }
        }
      } catch {
        return;
      }

      if (bytes <= job.lastPolledBytes) return;
      const delta = bytes - job.lastPolledBytes;
      job.lastPolledBytes = bytes;
      job.lastActivity = Date.now();
      const expected = job.expectedTotal > 0 ? job.expectedTotal : null;
      const ratio = expected ? (bytes / expected) * 100 : null;
      const progress = ratio
        ? Math.min(99.9, Math.max(job.progressFloor, ratio))
        : Math.min(99.9, job.progressFloor);
      void job.writer.enqueue({
        status: "downloading",
        progress,
        downloadedBytes: bytes,
        totalBytes: expected,
        speed: fmtSpeed(delta / 2),
        eta: expected && delta > 0 ? fmtEta(Math.max(0, (expected - bytes) / delta) * 2) : null,
      });
    }, 2000);
    job.progressPoller.unref?.();
  }

  private async finish(d: Download, job: Job, code: number | null) {
    this.jobs.delete(job.id);
    if (job.progressPoller) {
      clearInterval(job.progressPoller);
      job.progressPoller = null;
    }
    const rawLog = redactLog(job.log.join("\n"));

    if (job.cancelled) {
      this.schedulePump();
      return;
    }
    if (job.rateLimited) {
      await job.writer.enqueue({
        status: "failed",
        speed: null,
        eta: null,
        error:
          "الموقع رفض الطلب بسبب حد المعدل (HTTP 429) — حظر مؤقت لعنوان IP هذا. أضف كوكيز جلسة من الإعدادات، أو انتظر من دقائق إلى ساعات، أو شغّل التطبيق من شبكة منزلية بدل شبكة مركز بيانات. لن تُعاد المحاولة تلقائياً الآن.",
        log: rawLog || null,
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }
    if (job.timedOut) {
      await job.writer.enqueue({
        status: "failed",
        speed: null,
        eta: null,
        error: `توقّف المحرك عن إرسال أي بيانات لمدة ${Math.round(IDLE_TIMEOUT_MS / 60000)} دقيقة، فأُوقفت المهمة. الأسباب الشائعة: الكوكيز منتهية، أو الموقع يحجب هذا العنوان، أو الملف ضخم بلا استجابة.`,
        log: rawLog || null,
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }
    if (job.pausedByUser) {
      await job.writer.enqueue({ status: "paused", speed: null, eta: null });
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    // ---------------------------------------------------------------- skipped
    // yt-dlp exits 0 when the media is already in the download archive. That is
    // a success ("nothing to do"), never a failure (38 duplicate complaints).
    // A *retry of missing entries* that produced nothing is a different case and
    // must keep the missing list alive instead of pretending the file existed.
    if (code === 0 && job.finalPaths.length === 0) {
      const skipMeta = (d.metadata ?? {}) as Record<string, unknown>;
      const retryAttempts = typeof skipMeta.incompleteRetry === "number" ? skipMeta.incompleteRetry : 0;
      if (d.playlist && retryAttempts > 0) {
        const measure = this.measurePlaylist(d, job, rawLog, 0);
        const stillMissing =
          (measure.metadataPatch.missingItems as MissingEntry[] | undefined) ?? [];
        await job.writer.enqueue({
          status: "completed",
          progress: 100,
          speed: null,
          eta: null,
          completedEntries: 0,
          completedAt: new Date(),
          error: stillMissing.length
            ? `لم يُحفظ أي عنصر في محاولة إعادة الناقص (${d.playlistItems ?? "—"}). ما زالت ناقصة: ${stillMissing
                .map((entry) => `#${entry.index}`)
                .join("، ")} — غالباً محذوفة أو خاصة. المحاولة ${retryAttempts} من ${MAX_INCOMPLETE_RETRIES}.`
            : `لم يُحفظ أي عنصر في المحاولة (${d.playlistItems ?? "—"}) — لا شيء لتنزيله الآن.`,
          metadata: { ...skipMeta, ...measure.metadataPatch },
          log: rawLog || null,
        });
        await job.writer.flush();
        this.schedulePump();
        return;
      }

      await job.writer.enqueue({
        status: "completed",
        progress: 100,
        speed: null,
        eta: null,
        error: skipCompletionNote((await getSettings()).downloadArchive || isArchiveSkip(rawLog)),
        completedEntries: 0,
        completedAt: new Date(),
        log: rawLog || null,
        metadata: { ...((d.metadata ?? {}) as Record<string, unknown>), archiveSkip: true },
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    // A playlist where *some* entries failed exits non-zero, yet the files that
    // did download are real. Never throw them away as "failed" (Seal #736).
    if (code !== 0 && d.playlist && job.finalPaths.length > 0) {
      const previousPartial = (Array.isArray(d.files) ? d.files : []).filter((file) => existsSync(file));
      const mergedPartial = [...new Set([...previousPartial, ...job.finalPaths])];
      const partial = this.measurePlaylist(d, job, rawLog, mergedPartial.length);
      let bytes = 0;
      for (const file of job.finalPaths) {
        try {
          bytes += (await stat(file)).size;
        } catch {
          /* already gone */
        }
      }
      await job.writer.enqueue({
        status: "completed",
        progress: 100,
        speed: null,
        eta: null,
        filePath: mergedPartial[mergedPartial.length - 1] ?? null,
        fileName: mergedPartial.length
          ? path.basename(mergedPartial[mergedPartial.length - 1])
          : null,
        files: mergedPartial,
        completedEntries: mergedPartial.length,
        totalBytes: bytes || null,
        downloadedBytes: bytes || null,
        completedAt: new Date(),
        error: partial.note,
        log: redactLog(`${partial.note ?? ""}\n${rawLog}`),
        metadata: {
          ...((d.metadata ?? {}) as Record<string, unknown>),
          ...partial.metadataPatch,
        },
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    if (code === 0) {
      try {
        const paths = job.finalPaths.slice();
        let primary = paths[paths.length - 1] ?? null;

        if (d.kind === "audio" && d.container === "wma") {
          const ffmpeg = resolveBinary("ffmpeg", (await getSettings()).ffmpegPath);
          if (!ffmpeg || !primary) throw new Error("يتطلب تحويل WMA وجود FFmpeg ومسار ملف صالح.");
          await job.writer.enqueue({ status: "converting", progress: 99.9, speed: null, eta: null });
          const converted = await convertToWma(ffmpeg, primary);
          paths[paths.length - 1] = converted;
          primary = converted;
        }

        let totalBytes = 0;
        for (const file of paths) {
          try {
            totalBytes += (await stat(file)).size;
          } catch {
            /* file may already be gone */
          }
        }

        // A retry of missing entries must add to the record, not replace it.
        const previous = (Array.isArray(d.files) ? d.files : []).filter((file) => existsSync(file));
        const merged = [...new Set([...previous, ...paths])];

        // Seal #736: exit code 0 does not prove the playlist is whole.
        const integrity = this.measurePlaylist(d, job, rawLog, paths.length);
        const notComplete = integrity.note;

        await job.writer.enqueue({
          status: "completed",
          progress: 100,
          speed: null,
          eta: null,
          filePath: primary,
          fileName: primary ? path.basename(primary) : null,
          files: merged.length > 0 ? merged : null,
          completedEntries: merged.length,
          totalBytes: totalBytes || null,
          downloadedBytes: totalBytes || null,
          completedAt: new Date(),
          error: notComplete,
          log: notComplete ? redactLog(`${notComplete}\n${rawLog}`) : rawLog || null,
          metadata: {
          ...((d.metadata ?? {}) as Record<string, unknown>),
          ...integrity.metadataPatch,
        },
        });
      } catch (error) {
        await job.writer.enqueue({
          status: "failed",
          speed: null,
          eta: null,
          error: error instanceof Error ? error.message : "فشل إنهاء المهمة",
          log: redactLog(`${rawLog}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`),
        });
      }
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    const s = await getSettings();
    const fresh = await this.get(d.id);
    const rawError =
      extractYtDlpError(job.log.join("\n")) ||
      (job.log.filter((line) => line.trim()).slice(-1)[0] ?? "") ||
      `process exited with code ${code}`;
    const metadata = (d.metadata ?? {}) as Record<string, unknown>;
    const baseError = isCookiePermissionError(rawError)
      ? COOKIE_PERMISSION_MESSAGE
      : friendlyDownloadError(rawError, d.url);
    // Be explicit that the fallback client was tried too — otherwise the user
    // cannot tell whether a rotation ever happened.
    const errMsg = metadata.ytClient
      ? `${baseError} (جُرّب أيضاً عميل ${String(metadata.ytClient)} بعد فشل العميل الافتراضي.)`
      : baseError;

    // A retry-of-missing run that fails *again* (deleted/private entry) must not
    // wipe out the original report: the three files stay, and the missing entry
    // stays listed with a clear reason instead of turning the whole job into an
    // opaque "failed" row.
    if (d.playlist && job.finalPaths.length === 0) {
      const retryAttempts = typeof metadata.incompleteRetry === "number" ? metadata.incompleteRetry : 0;
      if (retryAttempts > 0) {
        const measure = this.measurePlaylist(d, job, rawLog, 0);
        const stillMissing = (measure.metadataPatch.missingItems as MissingEntry[] | undefined) ?? [];
        const previous = Array.isArray(metadata.missingItems) ? (metadata.missingItems as MissingEntry[]) : [];
        const merged = stillMissing.length ? stillMissing : previous;
        await job.writer.enqueue({
          status: "completed",
          progress: 100,
          completedEntries: d.completedEntries ?? 0,
          completedAt: new Date(),
          speed: null,
          eta: null,
          error: merged.length
            ? `لم يُنزَّل العنصر الناقص مرة أخرى (${merged.map((entry) => `#${entry.index}`).join("، ")}): ${errMsg} — المحاولة ${retryAttempts} من ${MAX_INCOMPLETE_RETRIES}. الملفات السابقة محفوظة ولم تُحذف.`
            : `لم ينتج عن محاولة إعادة الناقص أي ملف جديد: ${errMsg}`,
          metadata: { ...metadata, ...measure.metadataPatch, missingItems: merged },
          log: rawLog || null,
        });
        await job.writer.flush();
        this.schedulePump();
        return;
      }
    }

    // YouTube 403 / challenge failures: retry once with a different player
    // client, recorded in the job log so the reason is never a mystery.
    const rotation = shouldRotateYouTubeClient({
      url: d.url,
      exitCode: code,
      rawError,
      metadata,
    });
    if (rotation.rotate) {
      job.writer.reset();
      await job.writer.enqueue({
        status: "queued",
        provider: "ytdlp",
        metadata: { ...metadata, ytClient: rotation.client, ytAttempt: 1 },
        retries: 0,
        error: rotation.reason,
        log: rawLog || null,
        speed: null,
        eta: null,
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    // HLS gap: yt-dlp failed on a direct .m3u8 (usually headers/cookies) and
    // N_m3u8DL-RE is installed → let it try, exactly once.
    const nm3u8dlPath = resolveBinary("N_m3u8DL-RE", null);
    if (
      !metadata.hlsFallback &&
      nm3u8dlPath &&
      isHlsUrl(d.url) &&
      (d.provider ?? "ytdlp") === "ytdlp"
    ) {
      job.writer.reset();
      await job.writer.enqueue({
        status: "queued",
        provider: "nm3u8dl",
        metadata: { ...metadata, hlsFallback: true },
        retries: 0,
        error: `فشل yt-dlp على رابط m3u8 — تحويل تلقائي إلى N_m3u8DL-RE. (${errMsg})`,
        log: rawLog || null,
        speed: null,
        eta: null,
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    // Engine gap (not a transient error): hand the job to the other provider
    // once. Example: yt-dlp reports "No video could be found" for an Instagram
    // photo post, gallery-dl downloads it fine.
    const current = d.provider ?? "ytdlp";
    const next = current === "ytdlp" ? "gallerydl" : "ytdlp";
    const nextAvailable = Boolean(resolveBinary(next === "gallerydl" ? "gallery-dl" : "yt-dlp",
      next === "gallerydl" ? s.gallerydlPath : s.ytdlpPath));
    if (!metadata.providerFallback && nextAvailable && shouldTryFallback(rawError)) {
      job.writer.reset();
      await job.writer.enqueue({
        status: "queued",
        provider: next,
        metadata: { ...metadata, providerFallback: true },
        retries: 0,
        error: `المزوّد ${current} لا يدعم هذا الرابط — تحويل تلقائي إلى ${next}. (${errMsg})`,
        log: rawLog || null,
        speed: null,
        eta: null,
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    if (fresh && fresh.retries < s.maxRetries && !job.probeFailed) {
      const nextRetries = fresh.retries + 1;
      job.writer.reset();
      await job.writer.enqueue({
        status: "queued",
        retries: nextRetries,
        error: `إعادة المحاولة (${nextRetries}/${s.maxRetries}): ${errMsg}`,
        log: rawLog || null,
        speed: null,
        eta: null,
      });
    } else {
      await job.writer.enqueue({ status: "failed", error: errMsg, log: rawLog || null, speed: null, eta: null });
    }
    await job.writer.flush();
    this.schedulePump();
  }

  /**
   * N_m3u8DL-RE path (MIT binary, not vendored source).
   *
   * Used for direct HLS links where session headers matter, and as a fallback
   * when yt-dlp fails on `.m3u8`. DRM manifests are refused, never bypassed.
   */
  private async startNm3u8dl(
    d: Download,
    s: Settings,
    binary: string,
    ffmpeg: string | null,
    route: RouteResult,
  ) {
    if (!this.claim(d.id, "nm3u8dl")) return;
    try {
      mkdirSync(d.outputDir, { recursive: true });
    } catch (error) {
      await this.failBeforeStart(
        d.id,
        `تعذّر إنشاء مجلد الحفظ: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
      return;
    }

    // Referer/Cookie session headers — the whole reason this engine exists.
    // "Referer: …" per line from settings, plus the cookies.txt entries that
    // belong to the target host when the user asked for them.
    const userHeaders: Record<string, string> = parseHeaderLines(s.hlsHeaders);
    let cookieHeader: string | null = null;
    if (s.hlsUseCookies && s.cookiesPath && existsSync(s.cookiesPath)) {
      try {
        cookieHeader = buildCookieHeader(readFileSync(s.cookiesPath, "utf8"), d.url);
      } catch {
        /* unreadable cookies.txt must not block the download */
      }
    }

    // Which headers does this origin actually accept? Probe an ordered list
    // (user → watch page → same-origin) instead of guessing only once.
    const jobMeta = (d.metadata ?? {}) as Record<string, unknown>;
    const candidates = buildHeaderCandidates({
      userHeaders,
      pageUrl: typeof jobMeta.pageUrl === "string" ? jobMeta.pageUrl : null,
      manifestUrl: d.url,
      auto: s.hlsAutoHeaders !== false,
    });
    if (cookieHeader) {
      for (const candidate of candidates) {
        if (!candidate.headers.Cookie) candidate.headers.Cookie = cookieHeader;
      }
    }
    const probeResult = candidates.length
      ? await pickWorkingHeaders(candidates, d.url)
      : { chosen: null, attempts: [] as { label: string; status: number | null }[] };
    const preHeaders: Record<string, string> = probeResult.chosen?.headers ?? {};
    const headerNote = describeProbe(probeResult);

    // Cheap DRM pre-check on the manifest itself: refusing early is friendlier
    // than downloading segments and failing at the decrypt step. The same fetch
    // is reused to resolve the exact audio-language spelling.
    let manifestText = "";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const manifest = await fetch(d.url, {
        signal: controller.signal,
        headers: { ...preHeaders, "User-Agent": preHeaders["User-Agent"] ?? "BlackHoleUltra/1.0" },
      })
        .then((response) => (response.ok ? response.text() : ""))
        .catch(() => "");
      clearTimeout(timer);
      manifestText = manifest;
      if (looksLikeDrmManifest(manifest)) {
        await this.failBeforeStart(d.id, DRM_REFUSAL_MESSAGE, manifest.slice(0, 2_000));
        return;
      }
    } catch {
      /* manifest fetch is best-effort; the tool can still try */
    }

    const saveName = safeSaveName(d.title || "hls-video");
    const args = buildNm3u8dlArgs({
      url: d.url,
      outputDir: d.outputDir,
      saveName,
      threadCount: s.concurrentFragments,
      speedLimit: s.speedLimit,
      ffmpegPath: ffmpeg,
      headers: preHeaders,
      subtitles: d.subtitles,
      qualityLabel: d.qualityLabel,
      kind: d.kind === "audio" ? "audio" : "video",
      muxFormat:
        d.kind === "audio"
          ? null
          : d.container === "mkv"
            ? "mkv"
            : d.container === "ts"
              ? "ts"
              : "mp4",
      audioLang: resolveAudioLanguage(
        manifestText,
        (typeof jobMeta.hlsAudioLang === "string" ? jobMeta.hlsAudioLang : null) ?? s.hlsAudioLang,
      ),
      videoRange: (typeof jobMeta.hlsRange === "string" ? jobMeta.hlsRange : null) ?? s.hlsVideoRange,
      codecs: (typeof jobMeta.hlsCodecs === "string" ? jobMeta.hlsCodecs : null) ?? s.hlsCodecs,
    });

    let proc: ChildProcess;
    try {
      proc = spawn(binary, args, {
        windowsHide: true,
        env: { ...process.env, TERM: process.env.TERM ?? "xterm", DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
      });
    } catch (error) {
      await this.failBeforeStart(
        d.id,
        `تعذّر تشغيل N_m3u8DL-RE: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
      return;
    }

    const job: Job = {
      id: d.id,
      proc,
      pausedByUser: false,
      cancelled: false,
      timedOut: false,
      rateLimited: false,
      lastActivity: Date.now(),
      writer: this.makeWriter(d.id),
      lastDbWrite: 0,
      finalPaths: [],
      destinations: [],
      log: [],
      probeFailed: false,
      progressPoller: null,
      lastPolledBytes: 0,
      progressFloor: 0,
      expectedTotal: 0,
      items: [],
      producedIds: [],
      itemIndex: 0,
      playlistTotal: 0,
      hlsTracks: { tracks: 0, started: 0, counting: false },
      permanentFailure: false,
      externalDownloader: false,
    };
    this.jobs.set(d.id, job);
    job.log.push(headerNote);
    void job.writer.enqueue({
      status: "downloading",
      progress: 2,
      error: null,
      speed: null,
      eta: null,
      log: `المزوّد: N_m3u8DL-RE (HLS) — ${route.reason}\n${headerNote}`,
      metadata: { ...jobMeta, hlsHeadersUsed: probeResult.chosen?.label ?? null },
    });

    const handleOutput = (chunk: Buffer, isStdout: boolean) => {
      job.lastActivity = Date.now();
      const text = chunk.toString();

      const progress = parseNm3u8dlProgress(text);
      if (progress) {
        const overall = overallHlsPercent(job.hlsTracks, progress.percent);
        if (overall > job.progressFloor) job.progressFloor = overall;
        const now = Date.now();
        if (now - job.lastDbWrite > 500) {
          job.lastDbWrite = now;
          void job.writer.enqueue({
            status: "downloading",
            progress: Math.min(99.9, job.progressFloor),
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
            speed: progress.speed,
            eta: null,
          });
        }
        return;
      }

      // Keep the tool's real log lines (INFO/WARN/ERROR) even when the same
      // chunk also carries progress, so failures are never invisible.
      const withoutAnsi = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
      const logLines = withoutAnsi
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^(\d{2}:\d{2}:\d{2})?\s*(INFO|WARN|ERROR|FATAL)\s*:/i.test(line));
      if (logLines.length > 0) {
        for (const line of logLines) job.log.push(line);
        if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
        if (!job.permanentFailure && logLines.some((line) => isPermanentHlsFailure(line))) {
          job.permanentFailure = true;
          killProc(job.proc);
          return;
        }
      }

      const cleaned = withoutAnsi.trim();
      if (!cleaned) return;
      job.hlsTracks = updateHlsTracks(job.hlsTracks, cleaned);
      void isStdout;
    };

    proc.stdout?.on("data", (chunk: Buffer) => handleOutput(chunk, true));
    proc.stderr?.on("data", (chunk: Buffer) => handleOutput(chunk, false));
    proc.on("error", (error) => {
      job.probeFailed = true;
      job.log.push(`spawn error: ${error.message}`);
    });
    proc.on("close", (code) => void this.finishHls(d, job, code, saveName));
  }

  /** Finish handler for the HLS tool: its output is `<saveName>.<ext>`. */
  private async finishHls(d: Download, job: Job, code: number | null, saveName: string) {
    this.jobs.delete(job.id);
    if (job.progressPoller) {
      clearInterval(job.progressPoller);
      job.progressPoller = null;
    }
    const rawLog = redactLog(job.log.join("\n"));

    if (job.cancelled) {
      this.schedulePump();
      return;
    }
    if (job.pausedByUser) {
      await job.writer.enqueue({ status: "paused", speed: null, eta: null });
      await job.writer.flush();
      this.schedulePump();
      return;
    }
    if (job.timedOut) {
      await job.writer.enqueue({
        status: "failed",
        speed: null,
        eta: null,
        error: `توقّف N_m3u8DL-RE عن إرسال أي بيانات لمدة ${Math.round(IDLE_TIMEOUT_MS / 60000)} دقيقة فأُوقفت المهمة.`,
        log: rawLog || null,
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    const produced = (() => {
      try {
        return readdirSync(d.outputDir)
          .filter((name) => isOutputFileFor(name, saveName))
          .map((name) => path.join(d.outputDir, name));
      } catch {
        return [];
      }
    })();

    if (code === 0 && produced.length > 0) {
      let bytes = 0;
      for (const file of produced) {
        try {
          bytes += (await stat(file)).size;
        } catch {
          /* ignore */
        }
      }
      const primary = produced[produced.length - 1];
      await job.writer.enqueue({
        status: "completed",
        progress: 100,
        speed: null,
        eta: null,
        filePath: primary,
        fileName: path.basename(primary),
        files: produced,
        completedEntries: produced.length,
        totalBytes: bytes || null,
        downloadedBytes: bytes || null,
        completedAt: new Date(),
        error: null,
        log: rawLog || null,
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    if (looksLikeDrmFailure(rawLog)) {
      await job.writer.enqueue({
        status: "failed",
        speed: null,
        eta: null,
        error: DRM_REFUSAL_MESSAGE,
        log: rawLog || null,
      });
      await job.writer.flush();
      this.schedulePump();
      return;
    }

    const fresh = await this.get(d.id);
    const message = friendlyHlsError(rawLog || `exit code ${code}`);
    const s = await getSettings();
    // 404/403/"failed to parse" will not fix themselves: retrying just makes the
    // user wait ~10s per attempt for the same answer.
    const permanent = job.permanentFailure || isPermanentHlsFailure(rawLog);
    if (fresh && !permanent && fresh.retries < Math.min(2, s.maxRetries) && !job.probeFailed) {
      const nextRetries = fresh.retries + 1;
      job.writer.reset();
      await job.writer.enqueue({
        status: "queued",
        retries: nextRetries,
        error: `إعادة المحاولة (${nextRetries}): ${message}`,
        log: rawLog || null,
        speed: null,
        eta: null,
      });
    } else {
      await job.writer.enqueue({ status: "failed", error: message, log: rawLog || null, speed: null, eta: null });
    }
    await job.writer.flush();
    this.schedulePump();
  }

  /**
   * gallery-dl path: the reference tool for media posts (Instagram, X, Pinterest,
   * Reddit galleries …). It needs no FFmpeg and prints one absolute path per
   * downloaded file, which our existing parser already collects.
   */
  private async startGalleryDl(d: Download, s: Settings, gallerydl: string, route: RouteResult) {
    if (!this.claim(d.id, "gallerydl")) return;
    try {
      mkdirSync(d.outputDir, { recursive: true });
    } catch (error) {
      await this.failBeforeStart(
        d.id,
        `تعذّر إنشاء مجلد الحفظ: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
      return;
    }

    const args = [
      "-d",
      d.outputDir,
      "--no-mtime",
      "--windows-filenames",
      "-R",
      "4",
      "--http-timeout",
      "30",
      ...(s.speedLimit ? ["--limit-rate", s.speedLimit] : []),
      ...(s.cookiesPath?.trim() ? ["--cookies", s.cookiesPath.trim()] : []),
      ...(s.cookiesFromBrowser?.trim() ? ["--cookies-from-browser", s.cookiesFromBrowser.trim()] : []),
    ];
    if (d.playlistItems) {
      const [from, to] = d.playlistItems.split(/[-,]/);
      args.push("--range", to ? `${from}-${to}` : from);
    }
    args.push(d.url);

    let proc: ChildProcess;
    try {
      proc = spawn(gallerydl, args, { windowsHide: true, env: { ...process.env } });
    } catch (error) {
      await this.failBeforeStart(
        d.id,
        `تعذّر تشغيل gallery-dl: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
      return;
    }

    const job: Job = {
      id: d.id,
      proc,
      pausedByUser: false,
      cancelled: false,
      timedOut: false,
      rateLimited: false,
      lastActivity: Date.now(),
      writer: this.makeWriter(d.id),
      lastDbWrite: 0,
      finalPaths: [],
      destinations: [],
      log: [],
      probeFailed: false,
      progressPoller: null,
      lastPolledBytes: 0,
      progressFloor: 0,
      expectedTotal: 0,
      items: [],
      producedIds: [],
      itemIndex: 0,
      playlistTotal: 0,
      hlsTracks: { tracks: 0, started: 0, counting: false },
      permanentFailure: false,
      externalDownloader: args.includes("--downloader"),
    };
    this.jobs.set(d.id, job);
    void job.writer.enqueue({
      status: "downloading",
      progress: 5,
      error: null,
      speed: null,
      eta: null,
      log: `المزوّد: gallery-dl — ${route.reason}`,
    });

    const handleLine = (line: string) => {
      const text = line.trim();
      if (!text) return;
      if (isRateLimitMessage(text) && !job.rateLimited) {
        job.rateLimited = true;
        job.log.push(text);
        killProc(job.proc);
        return;
      }
      if (/^\[/.test(text)) {
        job.log.push(text);
        if (job.log.length > 200) job.log.shift();
        return;
      }
      if (path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
        if (!job.finalPaths.includes(text)) {
          job.finalPaths.push(text);
          void job.writer.enqueue({
            status: "downloading",
            progress: Math.min(95, 5 + job.finalPaths.length * 10),
          });
        }
      }
    };

    let lineBuf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      job.lastActivity = Date.now();
      lineBuf += chunk.toString();
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() ?? "";
      lines.forEach(handleLine);
    });
    proc.stderr?.on("data", (chunk: Buffer) => this.noteStderr(job, chunk));
    proc.on("error", (error) => {
      job.probeFailed = true;
      job.log.push(`spawn error: ${error.message}`);
    });
    proc.on("close", (code) => {
      if (lineBuf) handleLine(lineBuf);
      void this.finish(d, job, code);
    });
  }

  /**
   * stderr is not just noise: gallery-dl prints its 429 backoff there and
   * yt-dlp prints "ERROR: HTTP Error 429" there too. Both must be seen.
   */
  private noteStderr(job: Job, chunk: Buffer) {
    job.lastActivity = Date.now();
    const text = chunk.toString();

    // aria2c's own readout → real progress, and it never pollutes the log that
    // error extraction reads.
    const aria = parseAria2Progress(text);
    if (aria) {
      if (aria.percent > job.progressFloor) job.progressFloor = aria.percent;
      const now = Date.now();
      if (now - job.lastDbWrite > 500) {
        job.lastDbWrite = now;
        void job.writer.enqueue({
          status: "downloading",
          progress: Math.min(99.9, job.progressFloor),
          speed: aria.speed,
        });
      }
      return;
    }

    job.log.push(text);
    if (job.log.length > 200) job.log.shift();
    if (!job.rateLimited && isRateLimitMessage(text)) {
      job.rateLimited = true;
      killProc(job.proc);
    }
  }

  /**
   * Reconcile what was requested with what actually landed on disk and build the
   * user-facing note + the metadata the "retry missing" action needs.
   */
  private measurePlaylist(
    d: Download,
    job: Job,
    rawLog: string,
    producedCount: number,
  ): { note: string | null; metadataPatch: Record<string, unknown> } {
    if (!d.playlist) {
      const expected =
        playlistTotalFromLog(rawLog) ?? parsePlaylistSpecCount(d.playlistItems) ?? null;
      return { note: playlistCompletionNote(expected, producedCount), metadataPatch: {} };
    }

    if (process.env.BLACKHOLE_DEBUG_PLAYLIST === "1") {
      console.log("[bh-debug] items", job.items.length, "producedIds", job.producedIds.length, "paths", job.finalPaths.length);
    }
    const missing: MissingEntry[] = computeMissingEntries({
      requested: d.playlistItems,
      total: playlistTotalFromOutput(rawLog),
      items: job.items,
      producedIds: job.producedIds,
      log: rawLog,
    });

    if (missing.length === 0) {
      return { note: null, metadataPatch: { missingItems: [] } };
    }

    const expected =
      Math.max(
        playlistTotalFromOutput(rawLog) ?? 0,
        playlistSpecToIndicesLocal(d.playlistItems).length,
      ) || missing.length + producedCount;

    return {
      note: incompleteSummary(missing, expected),
      metadataPatch: { missingItems: missing, incompleteExpected: expected },
    };
  }

  /**
   * Re-queue only the entries that are missing. Bounded (MAX_INCOMPLETE_RETRIES)
   * so a deleted/private video cannot loop forever.
   */
  async retryMissing(id: number): Promise<{ ok: boolean; reason?: string }> {
    const row = await this.get(id);
    if (!row) return { ok: false, reason: "العنصر غير موجود." };
    const check = canRetryIncomplete((row.metadata ?? {}) as Record<string, unknown>);
    if (!check.ok) return { ok: false, reason: check.reason ?? "لا يمكن إعادة المحاولة." };

    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const missing = metadata.missingItems as MissingEntry[];
    const spec = retrySpecFor(missing);
    if (!spec) return { ok: false, reason: "لا توجد فهارس صالحة لإعادة المحاولة." };

    await db
      .update(downloads)
      .set({
        status: "queued",
        playlistItems: spec,
        retries: 0,
        progress: 0,
        speed: null,
        eta: null,
        error: `إعادة تحميل ${missing.length} عنصراً ناقصاً فقط (${spec}) — المحاولة ${Number(metadata.incompleteRetry ?? 0) + 1} من ${MAX_INCOMPLETE_RETRIES}.`,
        metadata: {
          ...metadata,
          incompleteRetry: Number(metadata.incompleteRetry ?? 0) + 1,
          missingItems: [],
        },
        updatedAt: new Date(),
      })
      .where(eq(downloads.id, id));
    this.schedulePump();
    return { ok: true };
  }

  private async failBeforeStart(id: number, message: string, log: string | null) {
    const writer = this.makeWriter(id);
    // A pre-start failure must be visible and must not be retried forever.
    await writer.enqueue({
      status: "failed",
      error: message,
      log,
      speed: null,
      eta: null,
      retries: 0,
    });
    await writer.flush();
  }

  async pause(id: number) {
    const job = this.jobs.get(id);
    if (job) {
      job.pausedByUser = true;
      killProc(job.proc);
      return;
    }
    await db
      .update(downloads)
      .set({ status: "paused", updatedAt: new Date() })
      .where(and(eq(downloads.id, id), eq(downloads.status, "queued")));
  }

  async resume(id: number) {
    const d = await this.get(id);
    if (!d) return;
    if (["paused", "failed", "cancelled", "missing"].includes(d.status)) {
      await db
        .update(downloads)
        .set({ status: "queued", error: null, retries: 0, updatedAt: new Date() })
        .where(eq(downloads.id, id));
      this.schedulePump();
    }
  }

  async cancel(id: number) {
    const job = this.jobs.get(id);
    if (job) {
      job.cancelled = true;
      killProc(job.proc);
      await job.writer.flush();
    }
    await db
      .update(downloads)
      .set({ status: "cancelled", speed: null, eta: null, updatedAt: new Date() })
      .where(eq(downloads.id, id));
  }

  /**
   * Remove a job. `deleteFile` also deletes the produced media (only inside the
   * allowed roots) plus yt-dlp leftovers — previously files were orphaned on
   * disk with no way to clean them from the UI.
   */
  async remove(id: number, options: { deleteFile?: boolean } = {}) {
    const row = await this.get(id);
    const job = this.jobs.get(id);
    if (job) {
      job.cancelled = true;
      killProc(job.proc);
      await job.writer.flush();
    }

    if (options.deleteFile && row) {
      const roots = allowedRoots([row.outputDir]);
      const candidates = new Set<string>();
      if (row.filePath) candidates.add(row.filePath);
      for (const file of row.files ?? []) candidates.add(file);
      for (const file of [...candidates]) {
        candidates.add(`${file}.part`);
        candidates.add(`${file}.ytdl`);
      }
      for (const file of candidates) {
        if (!isInsideAnyRoot(safeReal(path.dirname(file)), roots)) continue;
        await unlink(file).catch(() => undefined);
      }
    }

    await db.delete(downloads).where(eq(downloads.id, id));
    this.schedulePump();
  }

  async pauseAll() {
    for (const id of Array.from(this.jobs.keys())) await this.pause(id);
    await db
      .update(downloads)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(downloads.status, "queued"));
  }

  async resumeAll() {
    await db
      .update(downloads)
      .set({ status: "queued", error: null, retries: 0, updatedAt: new Date() })
      .where(inArray(downloads.status, ["paused", "failed"]));
    this.schedulePump();
  }

  async clearFinished(deleteFiles = false) {
    const rows = await db
      .select()
      .from(downloads)
      .where(inArray(downloads.status, ["completed", "cancelled"]));
    for (const row of rows) await this.remove(row.id, { deleteFile: deleteFiles });
  }

  isRunning(id: number) {
    return this.jobs.has(id);
  }

  get activeCount() {
    return this.jobs.size;
  }

  async libraryStats() {
    const rows = await db
      .select({
        count: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${downloads.totalBytes}), 0)`,
      })
      .from(downloads)
      .where(eq(downloads.status, "completed"));
    return { count: rows[0]?.count ?? 0, bytes: rows[0]?.bytes ?? 0 };
  }

  private async get(id: number) {
    const rows = await db.select().from(downloads).where(eq(downloads.id, id)).limit(1);
    return rows[0];
  }
}

function killProc(p: ChildProcess) {
  try {
    if (process.platform === "win32" && p.pid) {
      spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true });
    } else {
      p.kill("SIGTERM");
      setTimeout(() => {
        if (!p.killed) p.kill("SIGKILL");
      }, 3000).unref?.();
    }
  } catch {
    /* ignore */
  }
}

async function convertToWma(ffmpeg: string, inputPath: string): Promise<string> {
  const outputPath = inputPath.replace(/\.[^.]+$/, "") + ".wma";
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpeg, ["-y", "-i", inputPath, "-vn", "-c:a", "wmav2", "-b:a", "192k", outputPath], {
      windowsHide: true,
    });
    let error = "";
    p.stderr?.on("data", (chunk: Buffer) => {
      error += chunk.toString();
      if (error.length > 12_000) error = error.slice(-12_000);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0 && existsSync(outputPath)) resolve();
      else reject(new Error(`فشل تحويل WMA عبر FFmpeg: ${extractFfmpegError(error) || `code ${code}`}`));
    });
  });
  if (inputPath !== outputPath && existsSync(inputPath)) await unlink(inputPath).catch(() => undefined);
  return outputPath;
}

export function fmtBytes(n?: number | null): string {
  if (!n || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtSpeed(bps: number): string {
  if (!bps || Number.isNaN(bps)) return "";
  return `${fmtBytes(bps)}/s`;
}

function fmtEta(sec: number): string {
  if (!sec || Number.isNaN(sec)) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fileExists(p?: string | null): boolean {
  return Boolean(p && existsSync(p));
}

export type { DownloadStatus };

const g = globalThis as typeof globalThis & { __bhEngine?: DownloadEngine };
export const engine: DownloadEngine = g.__bhEngine ?? (g.__bhEngine = new DownloadEngine());
