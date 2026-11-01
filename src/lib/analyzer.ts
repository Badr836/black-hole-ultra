import { resolveBinary, runBinary } from "./binaries";
import { getSettings } from "./settings";
import { friendlyDownloadError, impersonationCaps, siteOptions } from "./site-options";
import { commonDownloadOptions } from "./download-options";
import { createLimiter, createTtlCache } from "./limiter";
import { getJsRuntimes, jsRuntimeArgs, pickJsRuntime } from "./runtimes";
import { platformHint, routeProvider } from "./providers";
import { effectiveCookiesPath } from "./cookies";
import {
  normalizeFormats,
  pickThumbnail,
  playlistEntries,
  type AudioOption,
  type RawInfo,
  type VideoOption,
} from "./analyzer-normalize";

export type { AudioOption, VideoOption };
export {
  AUDIO_CONTAINERS,
  QUALITY_PRESETS,
  VIDEO_CONTAINERS,
  isAudioContainer,
  isVideoContainer,
} from "./analyzer-normalize";

export interface AnalyzeResult {
  id: string;
  title: string;
  thumbnail: string | null;
  uploader: string | null;
  duration: number | null;
  webpageUrl: string;
  extractor: string;
  isPlaylist: boolean;
  entryCount: number | null;
  entries: { url: string; title: string }[];
  videoOptions: VideoOption[];
  audioOptions: AudioOption[];
  directOptions: VideoOption[];
  subtitles: string[];
  autoCaptions: string[];
  /** Set when the extractor could not report codec details (plain media URL). */
  directFile: boolean;
  /** Which engine will actually download this URL. */
  provider: "ytdlp" | "gallerydl";
  /** Suggested media kind (gallery posts may be images, not video). */
  mediaKind: "video" | "audio" | "image";
  /** Actionable note for login-walled platforms. */
  hint: string | null;
}

/** Analysis spawns yt-dlp; cap concurrency so ten clicks ≠ ten processes. */
const analyzeLimiter = createLimiter(2);
const analyzeCache = createTtlCache<AnalyzeResult>(5 * 60 * 1000);

export function clearAnalyzeCache(): void {
  analyzeCache.clear();
}

export async function analyzeUrl(url: string, asPlaylist: boolean): Promise<AnalyzeResult> {
  const cacheKey = `${asPlaylist ? "pl" : "one"}:${url}`;
  const cached = analyzeCache.get(cacheKey);
  if (cached) return cached;

  const result = await analyzeLimiter(() => analyzeUncached(url, asPlaylist));
  analyzeCache.set(cacheKey, result);
  return result;
}

async function analyzeUncached(url: string, asPlaylist: boolean): Promise<AnalyzeResult> {
  const s = await getSettings();
  const ytdlp = resolveBinary("yt-dlp", s.ytdlpPath);
  const gallerydl = resolveBinary("gallery-dl", s.gallerydlPath);
  if (!ytdlp && !gallerydl) {
    throw new Error("لا يوجد محرّك متاح. ثبّت yt-dlp (pip install -U yt-dlp) أو ضعه في مجلد bin/، ويُفضّل إضافة gallery-dl.");
  }

  const route = routeProvider(url, { ytdlp: Boolean(ytdlp), gallerydl: Boolean(gallerydl) }, s.providerPreference ?? "auto");
  if (route.provider === "gallerydl" && gallerydl) {
    return analyzeWithGalleryDl(url, s, gallerydl, route.reason);
  }
  if (!ytdlp) {
    throw new Error("yt-dlp غير موجود. ثبّته أو ضع yt-dlp(.exe) في مجلد bin/ أو حدّد مساره في الإعدادات.");
  }

  const caps = await impersonationCaps(() =>
    runBinary(ytdlp, ["--list-impersonate-targets"], { timeoutMs: 15_000 }).then(
      (r) => `${r.stdout}\n${r.stderr}`,
    ),
  );

  const jsArgs = jsRuntimeArgs(pickJsRuntime(await getJsRuntimes()), s.jsRuntimePath);
  const baseArgs = [
    "-J",
    "--no-warnings",
    ...(s.allowInsecureTls ? ["--no-check-certificates"] : []),
    ...commonDownloadOptions(s),
    // Analysis hits the same JS challenges as the download (yt-dlp #15012).
    ...jsArgs,
    ...siteOptions(url, 0, { impersonate: caps.supported, availableProfiles: caps.targets }),
  ];

  let stdout: string;
  try {
    ({ stdout } = await runBinary(
      ytdlp,
      [...baseArgs, asPlaylist ? "--yes-playlist" : "--no-playlist", "--flat-playlist", url],
      { timeoutMs: 120_000 },
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(friendlyDownloadError(message, url));
  }

  const info = JSON.parse(stdout) as RawInfo;
  const result = await buildAnalyzeResult(info, url, { asPlaylist, ytdlp, baseArgs });
  if (result.videoOptions.length === 0 && result.audioOptions.length === 0 && gallerydl) {
    // yt-dlp sees "nothing to download" (e.g. an image post) → ask gallery-dl.
    try {
      return await analyzeWithGalleryDl(url, s, gallerydl, "yt-dlp لم يجد وسائط — gallery-dl");
    } catch {
      return result;
    }
  }
  return result;
}

export async function buildAnalyzeResult(
  info: RawInfo,
  url: string,
  opts: { asPlaylist: boolean; ytdlp: string; baseArgs: string[] },
): Promise<AnalyzeResult> {
  const isPlaylist = (info._type === "playlist" || Array.isArray(info.entries)) && Array.isArray(info.entries);
  const entries = isPlaylist ? playlistEntries(info).slice(0, 500) : [];

  // Playlist entries from --flat-playlist carry no formats; inspect the first one.
  let target: RawInfo = info;
  if (isPlaylist && entries[0]) {
    try {
      const probe = await runBinary(
        opts.ytdlp,
        [...opts.baseArgs, "--no-playlist", entries[0].url],
        { timeoutMs: 120_000 },
      );
      target = JSON.parse(probe.stdout) as RawInfo;
    } catch {
      target = info.entries?.[0] ?? info;
    }
  }

  const { videoOptions, audioOptions, directOptions } = normalizeFormats(target.formats ?? []);
  const mergedVideo = [...videoOptions, ...directOptions];

  return {
    id: info.id ?? target.id ?? "unknown",
    title: info.title ?? target.title ?? "Untitled",
    thumbnail: pickThumbnail(target, info),
    uploader: info.uploader ?? info.channel ?? target.uploader ?? null,
    duration: target.duration ?? null,
    webpageUrl: info.webpage_url ?? url,
    extractor: info.extractor_key ?? "generic",
    isPlaylist,
    entryCount: isPlaylist ? info.playlist_count ?? info.entries?.length ?? entries.length : null,
    entries,
    videoOptions: mergedVideo,
    audioOptions,
    directOptions,
    subtitles: Object.keys(target.subtitles ?? {}),
    autoCaptions: Object.keys(target.automatic_captions ?? {}).slice(0, 30),
    directFile: mergedVideo.some((option) => option.single) && videoOptions.length === 0,
    provider: "ytdlp",
    mediaKind: mergedVideo.length > 0 ? "video" : audioOptions.length > 0 ? "audio" : "video",
    hint: platformHint(url),
  };
}

const VIDEO_EXT = new Set(["mp4", "mkv", "webm", "mov", "m4v", "ts", "flv"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "flac", "opus", "ogg", "wav"]);

type GalleryEntry = Record<string, unknown>;

function parseGalleryJson(stdout: string): GalleryEntry[] {
  const parsed = JSON.parse(stdout) as unknown;
  const out: GalleryEntry[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      // gallery-dl emits [index, metadata] pairs, sometimes nested by category.
      if (node.length === 2 && typeof node[0] === "number" && node[1] && typeof node[1] === "object") {
        out.push(node[1] as GalleryEntry);
        return;
      }
      node.forEach(walk);
    }
  };
  walk(parsed);
  return out;
}

/**
 * gallery-dl analysis: it reports the media a post actually contains
 * (photos, videos, galleries), which is exactly what yt-dlp refuses to do.
 */
async function analyzeWithGalleryDl(
  url: string,
  s: { cookiesPath: string | null; cookiesFromBrowser: string | null },
  gallerydl: string,
  reason: string,
): Promise<AnalyzeResult> {
  const args = [
    "-j",
    "--range",
    "1-1",
    ...(effectiveCookiesPath(s.cookiesPath) ? ["--cookies", effectiveCookiesPath(s.cookiesPath) as string] : []),
    ...(s.cookiesFromBrowser?.trim() ? ["--cookies-from-browser", s.cookiesFromBrowser.trim()] : []),
    url,
  ];
  let stdout: string;
  try {
    ({ stdout } = await runBinary(gallerydl, args, { timeoutMs: 90_000 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const friendly = friendlyDownloadError(message, url);
    const hint = platformHint(url);
    const alreadyExplained = hint ? friendly.includes("كوكيز") || friendly.includes("تسجيل دخول") : true;
    throw new Error(hint && !alreadyExplained ? `${friendly} — ${hint}` : friendly);
  }

  let entries: GalleryEntry[] = [];
  try {
    entries = parseGalleryJson(stdout);
  } catch {
    entries = [];
  }

  const extensions = entries
    .map((entry) => String(entry.extension ?? "").toLowerCase())
    .filter((extension) => extension.length > 0);
  const entriesCount = Math.max(entries.length, 1);
  const primaryKind: "video" | "image" = extensions.some((ext) => VIDEO_EXT.has(ext)) ? "video" : "image";
  const first = entries[0] ?? {};
  const ext = extensions[0] || (primaryKind === "video" ? "mp4" : "jpg");
  const title =
    (typeof first.title === "string" && first.title) ||
    (typeof first.filename === "string" && first.filename) ||
    (typeof first.content === "string" && first.content.slice(0, 120)) ||
    `منشور (${entriesCount} وسائط)`;

  const option: VideoOption = {
    formatId: "gallery",
    label: `${primaryKind === "video" ? "فيديو" : "صورة"} (${ext.toUpperCase()}) · ${entriesCount} ملف`,
    height: 0,
    fps: null,
    ext,
    vcodec: "",
    filesize: null,
    tbr: null,
    hasAudio: primaryKind === "video",
    single: true,
  };

  return {
    id: String(first.id ?? "gallery"),
    title: String(title).slice(0, 200),
    thumbnail: typeof first.thumbnail === "string" ? first.thumbnail : null,
    uploader:
      (typeof first.username === "string" && first.username) ||
      (typeof first.author === "string" && first.author) ||
      null,
    duration: null,
    webpageUrl: url,
    extractor: String(first.category ?? "gallery-dl"),
    isPlaylist: entriesCount > 1,
    entryCount: entriesCount > 1 ? entriesCount : null,
    entries: [],
    videoOptions: primaryKind === "video" ? [option] : [],
    audioOptions: [],
    directOptions: primaryKind === "video" ? [] : [option],
    subtitles: [],
    autoCaptions: [],
    directFile: true,
    provider: "gallerydl",
    mediaKind: primaryKind,
    hint: platformHint(url) ?? reason,
  };
}
