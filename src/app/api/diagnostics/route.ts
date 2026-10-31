import { NextResponse } from "next/server";
import path from "node:path";
import { statfsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { downloads } from "@/db/schema";
import { resolveBinary, binaryVersion, runBinary } from "@/lib/binaries";
import { getSettings } from "@/lib/settings";
import { impersonationCaps, resetImpersonationCache } from "@/lib/site-options";
import { allowedRoots, formatFreeSpace } from "@/lib/safe-path";
import { currentVersion, sqlite } from "@/db";
import { cookieCoverage, readCookieFile } from "@/lib/cookies";
import { getJsRuntimes, pickJsRuntime, runtimeSummary, RUNTIME_INSTALL_HINTS } from "@/lib/runtimes";
import { archiveFilePath } from "@/lib/yt-policy";
import { classifyYoutubeProbe, YOUTUBE_PROBE_URL } from "@/lib/youtube-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  const s = await getSettings();
  const ytdlp = resolveBinary("yt-dlp", s.ytdlpPath);
  const ffmpeg = resolveBinary("ffmpeg", s.ffmpegPath);
  const sibling = ffmpeg
    ? path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : null;
  const ffprobe = resolveBinary("ffprobe", sibling);

  const gallerydl = resolveBinary("gallery-dl", s.gallerydlPath);
  const aria2c = resolveBinary("aria2c", null);
  const nm3u8dl = resolveBinary("N_m3u8DL-RE", null);
  const [ytdlpVersion, ffmpegVersion, ffprobeVersion, gallerydlVersion, aria2cVersion, nm3u8dlVersion, runtimes] =
    await Promise.all([
      binaryVersion(ytdlp, ["--version"]),
      binaryVersion(ffmpeg, ["-version"]),
      binaryVersion(ffprobe, ["-version"]),
      binaryVersion(gallerydl, ["--version"]),
      binaryVersion(aria2c, ["--version"]),
      binaryVersion(nm3u8dl, ["--version"]).then((v) => (v ? v.split("+")[0] : v)),
      getJsRuntimes(true),
    ]);

  const warnings: string[] = [];

  // Every optional feature reports enabled / disabled / unavailable-with-reason
  // (naqid round 2, condition 6) — no silent no-ops.
  const runtime = runtimeSummary(runtimes);
  const runtimeOk = Boolean(pickJsRuntime(runtimes));
  const features = {
    jsRuntime: {
      state: runtimeOk ? "active" : runtimes.length ? "unsupported" : "missing",
      message: runtime.message,
      hint: runtime.hint,
      override: s.jsRuntimePath,
      runtimes: runtimes.map((item) => ({
        name: item.name,
        path: item.path,
        version: item.version,
        supported: item.supported,
        reason: item.reason,
      })),
    },
    externalDownloader: {
      configured: s.externalDownloader,
      available: Boolean(aria2c),
      path: aria2c,
      version: aria2cVersion,
      state:
        s.externalDownloader !== "aria2c"
          ? "disabled"
          : aria2c
            ? "active"
            : "unavailable",
      note:
        s.externalDownloader === "aria2c"
          ? "يُستخدم لبروتوكول http فقط؛ DASH/HLS يبقى على منزّل yt-dlp الداخلي."
          : "المنزّل الخارجي مُعطّل (الافتراضي). التفعيل يسرّع الروابط المباشرة فقط.",
    },
    downloadArchive: {
      enabled: s.downloadArchive,
      file: archiveFilePath(s.outputDir),
      state: s.downloadArchive ? "active" : "disabled",
    },
    sponsorBlock: {
      mode: s.sponsorBlock,
      state: s.sponsorBlock === "off" ? "disabled" : "active",
      thirdParty: "sponsor.ink",
      note: "عند التفعيل يُرسل معرّف الفيديو إلى خدمة SponsorBlock الخارجية.",
    },
    concurrentFragments: { value: s.concurrentFragments, state: "active" },
    hlsEngine: {
      state: nm3u8dl ? "active" : "missing",
      version: nm3u8dlVersion,
      path: nm3u8dl,
      note: nm3u8dl
        ? "N_m3u8DL-RE (MIT) للروابط m3u8 المحمية بجلسة، ويُستخدم تلقائياً عند فشل yt-dlp على HLS."
        : "غير مثبّت — ضع الملف التنفيذي في مجلد bin/ لتفعيل مزوّد HLS الثاني.",
    },
  };

  if (!runtimeOk) {
    warnings.push(`${runtime.message}${runtime.hint ? ` — ${runtime.hint}` : ""}`);
  }
  if (s.externalDownloader === "aria2c" && !aria2c) {
    warnings.push(`المنزّل الخارجي مفعّل لكن aria2c غير موجود. ثبّته (apt install aria2) أو عطّل الخيار من الإعدادات.`);
  }

  // Real counts instead of impressions: which provider fails, how often.
  let providerStats: { provider: string; status: string; count: number }[] = [];
  try {
    providerStats = await db
      .select({
        provider: sql<string>`coalesce(${downloads.provider}, 'ytdlp')`,
        status: sql<string>`${downloads.status}`,
        count: sql<number>`count(*)`,
      })
      .from(downloads)
      .groupBy(sql`coalesce(${downloads.provider}, 'ytdlp')`, downloads.status);
  } catch {
    /* database not ready */
  }

  // Freshness of the local engines, from the cached upstream snapshot only
  // (no network calls inside the diagnostics request).
  let engineFreshness: { checkedAt: string | null; staleEngines: { name: string; installed: string | null; latest: string | null }[]; note: string | null } = {
    checkedAt: null,
    staleEngines: [],
    note: "لا توجد نتيجة فحص محفوظة؛ شغّل «فحص التحديثات» في الإعدادات.",
  };
  try {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), "data", "upstream-cache.json"), "utf8")) as {
      checkedAt?: string;
      engines?: { name: string; installed?: string | null; latest?: string | null; behind?: boolean }[];
    };
    const stale = (raw.engines ?? []).filter((item) => item.behind);
    engineFreshness = {
      checkedAt: raw.checkedAt ?? null,
      staleEngines: stale.map((item) => ({ name: item.name, installed: item.installed ?? null, latest: item.latest ?? null })),
      note: stale.length > 0 ? `هناك ${stale.length} محرك خلف أحدث إصدار — حدّثه لتجنّب أعطال المستخرجات.` : null,
    };
    if (stale.length > 0) {
      warnings.push(
        `محرك قديم: ${stale.map((item) => `${item.name} (${item.installed ?? "?"} ← ${item.latest ?? "?"})`).join(", ")}. شغّل «تحديث المحركات» من الإعدادات.`,
      );
    }
  } catch {
    /* no cache yet */
  }

  const coverage = cookieCoverage(readCookieFile(s.cookiesPath));

  let extractorCount = 0;
  if (!coverage.hasCookies) {
    warnings.push(
      "لا توجد كوكيز محفوظة. إنستغرام وريديت وبعض محتوى Vimeo/X تتطلب جلسة مسجّلة — ارفع cookies.txt من الإعدادات.",
    );
  }
  if (ytdlp) {
    try {
      const result = await runBinary(ytdlp, ["--list-extractors"], { timeoutMs: 30_000 });
      extractorCount = result.stdout.split(/\r?\n/).filter(Boolean).length;
    } catch (error) {
      warnings.push(`تعذّر تعداد مستخرجات المواقع: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    warnings.push("yt-dlp غير موجود؛ التحميل مستحيل حتى تثبّته أو تحدد مساره.");
  }

  resetImpersonationCache();
  const caps = ytdlp
    ? await impersonationCaps(() =>
        runBinary(ytdlp, ["--list-impersonate-targets"], { timeoutMs: 15_000 }).then(
          (r) => `${r.stdout}\n${r.stderr}`,
        ),
      )
    : { supported: false, targets: [] };
  if (!caps.supported) {
    warnings.push(
      'انتحال بصمة المتصفح غير متاح (مطلوب لبعض مواقع TikTok). ثبّت: pip install -U "yt-dlp[default,curl-cffi]". التحميل من بقية المواقع يعمل عادةً بدونه.',
    );
  }

  let outputWritable = false;
  const probeFile = path.join(s.outputDir, `.blackhole-write-test-${process.pid}`);
  try {
    writeFileSync(probeFile, "ok", { flag: "wx" });
    unlinkSync(probeFile);
    outputWritable = true;
  } catch (error) {
    warnings.push(`مجلد الحفظ غير قابل للكتابة: ${error instanceof Error ? error.message : String(error)}`);
  }

  let freeBytes: number | null = null;
  try {
    const info = statfsSync(s.outputDir);
    freeBytes = Number(info.bavail) * Number(info.bsize);
    if (freeBytes < 2 * 1024 ** 3) {
      warnings.push(`المساحة الحرة منخفضة (${formatFreeSpace(freeBytes)}). التحميلات الكبيرة قد تفشل.`);
    }
  } catch {
    /* not fatal */
  }

  const ffmpegMajor = ffmpegVersion?.match(/ffmpeg version\s+([^\s]+)/)?.[1] ?? null;
  const ffprobeMajor = ffprobeVersion?.match(/ffprobe version\s+([^\s]+)/)?.[1] ?? null;
  const mediaToolsMatch = Boolean(ffmpegMajor && ffprobeMajor && ffmpegMajor === ffprobeMajor);
  if (ffmpeg && ffprobe && !mediaToolsMatch) {
    warnings.push("إصدار FFmpeg لا يطابق FFprobe؛ يُفضّل تثبيتهما من الحزمة نفسها.");
  }

  let schemaVersion = 0;
  try {
    schemaVersion = currentVersion(sqlite);
  } catch {
    warnings.push("تعذّر قراءة إصدار مخطط قاعدة البيانات.");
  }

  // One cheap metadata probe tells the user whether YouTube is blocked here.
  let youtubeHealth: ReturnType<typeof classifyYoutubeProbe> = {
    state: "unknown",
    message: "لم يُفحص يوتيوب (yt-dlp غير متاح).",
    action: null,
  };
  if (ytdlp) {
    try {
      const probe = await runBinary(ytdlp, ["--no-warnings", "--no-playlist", "-J", "--skip-download", YOUTUBE_PROBE_URL], {
        timeoutMs: 25_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      youtubeHealth = classifyYoutubeProbe({ code: 0, stdout: probe.stdout, stderr: probe.stderr });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      youtubeHealth = classifyYoutubeProbe({ code: 1, stdout: "", stderr: message });
    }
  }
  if (youtubeHealth.action) warnings.push(`يوتيوب: ${youtubeHealth.message} — ${youtubeHealth.action}`);

  const checks = {
    ytdlp: { ok: Boolean(ytdlpVersion), path: ytdlp, version: ytdlpVersion },
    youtube: youtubeHealth,
    ffmpeg: { ok: Boolean(ffmpegVersion), path: ffmpeg, version: ffmpegMajor },
    ffprobe: { ok: Boolean(ffprobeVersion), path: ffprobe, version: ffprobeMajor },
    gallerydl: { ok: Boolean(gallerydlVersion), path: gallerydl, version: gallerydlVersion },
    providerPreference: s.providerPreference,
    cookies: { hasCookies: coverage.hasCookies, count: coverage.count, sessions: coverage.sessions },
    mediaToolsMatch,
    impersonation: { supported: caps.supported, targets: caps.targets },
    extractorCount,
    outputWritable,
    freeSpace: { bytes: freeBytes, human: formatFreeSpace(freeBytes) },
    outputDir: s.outputDir,
    allowedRoots: allowedRoots([s.outputDir]),
    allowInsecureTls: s.allowInsecureTls,
    database: { engine: "sqlite", schemaVersion },
    nodeRuntime: { ok: true, version: process.version },
    aria2c: { ok: Boolean(aria2cVersion), path: aria2c, version: aria2cVersion },
    nm3u8dl: { ok: Boolean(nm3u8dlVersion), path: nm3u8dl, version: nm3u8dlVersion },
    features,
    providerStats,
    engineFreshness,
    runtimeHints: RUNTIME_INSTALL_HINTS,
  };
  const ok = checks.ytdlp.ok && checks.ffmpeg.ok && checks.ffprobe.ok && outputWritable;
  if (!checks.gallerydl.ok) {
    warnings.push("gallery-dl غير مثبّت (اختياري لكنه يفتح إنستغرام/X/Pinterest وغيرها): pip install -U gallery-dl");
  }
  return NextResponse.json({ ok, checks, warnings, elapsedMs: Date.now() - started });
}

