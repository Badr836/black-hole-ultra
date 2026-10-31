import path from "node:path";

/**
 * Pure download policies derived from real user complaints (see
 * docs/issue-mining.md and docs/issue-decisions.md). Everything here is
 * side-effect free so it can be unit-tested without spawning yt-dlp.
 */

/* ------------------------------------------------------------------ YouTube */

/** YouTube player clients we may fall back to, in order. */
export const YOUTUBE_FALLBACK_CLIENTS = ["android_vr"] as const;

/** Sort of URL shapes where a player-client rotation is meaningful. */
export function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host.endsWith(".youtube.com")
    );
  } catch {
    return false;
  }
}

/**
 * Signals that YouTube refused *this player client* rather than the video being
 * gone (yt-dlp #17456, cobalt #1356). Deliberately narrow: "Video unavailable"
 * and "Private video" must not trigger a rotation loop.
 */
export function looksLikeYouTubeClientBlock(raw: string): boolean {
  const text = raw ?? "";
  if (/video unavailable|private video|removed by the uploader|members-only/i.test(text)) return false;
  return /HTTP Error 403|403: Forbidden|The current session has been rate-limited|unable to extract|nsig|n challenge solving failed|Failed to extract any player response|sign in to confirm you(?:'|’)re not a bot|Requested format is not available/i.test(
    text,
  );
}

export function youTubeClientArgs(client: string | null | undefined): string[] {
  const value = client?.trim();
  if (!value || !/^[a-z0-9_,.-]{2,60}$/i.test(value)) return [];
  return ["--extractor-args", `youtube:player_client=${value}`];
}

export type RotationInput = {
  url: string;
  exitCode: number | null;
  rawError: string;
  metadata: Record<string, unknown> | null;
};

export type RotationDecision = { rotate: false } | { rotate: true; client: string; reason: string };

/**
 * Rotate the player client **once**, **after** a real failure, and only for
 * YouTube. Never as the primary path: `android_vr` advertises far fewer formats
 * (5 vs ~60 here), so using it up front would silently cost the user quality.
 */
export function shouldRotateYouTubeClient(input: RotationInput): RotationDecision {
  const meta = input.metadata ?? {};
  if (input.exitCode === 0) return { rotate: false };
  if (!isYouTubeUrl(input.url)) return { rotate: false };
  if (meta.providerFallback) return { rotate: false };
  // Rotate when the runtime client is unset *or* was some other client that
  // failed — but never a second time once the fallback itself failed.
  const used = typeof meta.ytClient === "string" ? meta.ytClient : "";
  if (used === YOUTUBE_FALLBACK_CLIENTS[0]) return { rotate: false };
  if (typeof meta.ytAttempt === "number" && meta.ytAttempt >= 1) return { rotate: false };
  if (!looksLikeYouTubeClientBlock(input.rawError)) return { rotate: false };
  const client = YOUTUBE_FALLBACK_CLIENTS[0];
  return {
    rotate: true,
    client,
    reason:
      `يوتيوب رفض طلب العميل ${used || "الافتراضي"}. أُعيدت المحاولة مرة واحدة بعميل ${client} ` +
      `(عدد جودات أقل، لكنه يتجاوز 403 أحياناً). التفاصيل: ${input.rawError.slice(0, 240)}`,
  };
}

/* -------------------------------------------------------- Download archive */

export function archiveFilePath(outputDir: string): string {
  return path.join(outputDir, ".blackhole-archive.txt");
}

export function downloadArchiveArgs(enabled: boolean, outputDir: string, skip = false): string[] {
  if (skip || !enabled) return [];
  return ["--download-archive", archiveFilePath(outputDir)];
}

/** yt-dlp's "nothing to do" success notice — must not be reported as failure. */
export function isArchiveSkip(raw: string): boolean {
  return /has already been recorded in the (download )?archive/i.test(raw ?? "");
}

/**
 * yt-dlp runs with `--print` (which implies `--quiet`), so the archive notice is
 * usually not printed at all. A success exit with zero produced files *is* the
 * skip signal; we explain which of the two reasons applied.
 */
export function skipCompletionNote(archiveEnabled: boolean): string {
  return archiveEnabled
    ? "تم تخطيه: هذا العنصر مسجّل مسبقاً في أرشيف مجلد الحفظ، ولم يُنزَّل مرة أخرى. لإعادة تحميله احذف سطره من الملف .blackhole-archive.txt في مجلد الحفظ."
    : "تم تخطيه: الملف موجود مسبقاً في مجلد الحفظ، فلم يُنزَّل شيء الآن. احذف الملف أو أعد التسمية إن أردت تحميله من جديد.";
}

/* ------------------------------------------------------------ SponsorBlock */

export type SponsorBlockMode = "off" | "mark" | "remove";

export function sponsorBlockArgs(mode: string | null | undefined, isYouTube: boolean): string[] {
  if (!isYouTube) return [];
  const value = (mode ?? "off").toLowerCase();
  if (value === "remove") return ["--sponsorblock-remove", "sponsor"];
  if (value === "mark") return ["--sponsorblock-mark", "sponsor"];
  return [];
}

/* ----------------------------------------------------------------- Cookies */

/** yt-dlp #7271: reading Chrome's cookie DB fails on Windows (DPAPI lock). */
export function isCookiePermissionError(raw: string): boolean {
  const text = raw ?? "";
  return (
    /could not copy .*cookie|Permission denied.*cookie|cookie.*Permission denied|Failed to decrypt with DPAPI|os error 32|The process cannot access the file/i.test(
      text,
    ) || /cookies?.*(read|open).*(EACCES|EPERM)/i.test(text)
  );
}

export const COOKIE_PERMISSION_MESSAGE =
  "تعذّر قراءة كوكيز المتصفح: الملف مقفول أو مشفّر. أغلق المتصفح تماماً (بما في ذلك الأيقونة في شريط المهام) ثم أعد المحاولة، " +
  "أو صدّر الكوكيز إلى ملف cookies.txt وأضفه من الإعدادات. على ويندوز يقوم Chrome بتشفير الكوكيز وقد يمنع القراءة حتى مع الإغلاق.";

/* ------------------------------------------------------ Playlist integrity */

export function parsePlaylistSpecCount(spec: string | null | undefined): number | null {
  if (!spec?.trim()) return null;
  const parts = spec.split(",").map((chunk) => chunk.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let total = 0;
  for (const part of parts) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from) total += to - from + 1;
      continue;
    }
    if (/^\d+$/.test(part)) total += 1;
  }
  return total || null;
}

/** yt-dlp prints "Downloading item 3 of 12" — the only trustworthy total. */
export function playlistTotalFromLog(log: string): number | null {
  let max = 0;
  for (const match of (log ?? "").matchAll(/Downloading item \d+ of (\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max || null;
}

/**
 * Seal #736 "playlist download not complete": yt-dlp can exit 0 while some
 * entries failed. Say so instead of pretending the playlist is whole.
 */
export function playlistCompletionNote(
  expected: number | null,
  produced: number,
): string | null {
  if (!expected || expected <= 0) return null;
  if (produced >= expected) return null;
  return `ملاحظة: قد تكون القائمة ناقصة — تم حفظ ${produced} من ${expected} عنصراً. راجع السجل أو أعد المحاولة لاحقاً.`;
}

/* ------------------------------------------------- External downloader */

export type ExternalDownloader = "off" | "aria2c";

/**
 * aria2c is opt-in, and always addressed as `http:aria2c` so yt-dlp keeps its
 * own downloader for DASH/HLS fragments. A bare `aria2c` would try to handle
 * m3u8/dash too (it fails there) — that is the bug we are avoiding.
 */
export function externalDownloaderArgs(
  mode: string | null | undefined,
  binaryPath: string | null,
  options: { isDashOrHls?: boolean; allowed?: boolean } = {},
): string[] {
  if ((mode ?? "off") !== "aria2c") return [];
  if (!binaryPath) return [];
  if (options.isDashOrHls) return [];
  if (options.allowed === false) return [];
  return ["--downloader", `http:${binaryPath}`, "--downloader-args", "aria2c:--min-split-size=1M"];
}

/**
 * `--print "before_dl:BHDEST:<file>|<bytes>"` — yt-dlp runs with `--quiet`
 * (implied by --print), so "Destination:" lines disappear. This marker gives the
 * external-downloader progress poller both the file name and the expected size.
 */
export function parseDestinationMarker(text: string): { path: string; size: number } | null {
  const match = (text ?? "").match(/^BHDEST:(.+?)(?:\|(-?\d+|NA))?$/);
  if (!match) return null;
  const file = match[1].trim();
  if (!file) return null;
  const size = Number(match[2]);
  return { path: file, size: Number.isFinite(size) && size > 0 ? size : 0 };
}

/**
 * aria2c writes its own readout to stderr, e.g.
 *   [#30b124 13MiB/14MiB(95%) CN:1 DL:1.9MiB ETA:1s]
 * Parsing it gives us a real percentage even though yt-dlp stays silent.
 */
export function parseAria2Progress(text: string): { percent: number; speed: string | null } | null {
  const matches = [...(text ?? "").matchAll(/\[#[0-9a-f]{6}[^\]]*?\((\d{1,3})%\)[^\]]*?\]/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const percent = Number(last[1]);
  if (!Number.isFinite(percent)) return null;
  const speed = last[0].match(/DL:([\d.]+)([KMG])i?B/i);
  return {
    percent: Math.min(99.9, Math.max(0, percent)),
    speed: speed ? `${speed[1]} ${speed[2]}B/s` : null,
  };
}

/** Coarse protocol hint from the chosen selector/container. */
export function looksLikeDashOrHls(selector: string, container: string): boolean {
  return /m3u8|mpd|hls|dash/i.test(selector ?? "") || container === "m3u8" || container === "mpd";
}
