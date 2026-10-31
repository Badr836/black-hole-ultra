/**
 * HLS provider: N_m3u8DL-RE (MIT, https://github.com/nilaoda/N_m3u8DL-RE).
 *
 * Licence decision (recorded in docs/github-research.md):
 *  - we ship/execute it as an *external binary*, we do not copy its source;
 *  - MIT is compatible with this project's licence, so redistribution of the
 *    unmodified binary alongside our own code is allowed.
 *
 * Why a second HLS engine at all: yt-dlp is excellent at *finding* streams, but
 * N_m3u8DL-RE is better at session-protected HLS (custom headers, cookies,
 * per-segment retries, segment-count verification) and at muxing multi-track
 * HLS. It is therefore used for direct `.m3u8` links and as a fallback when
 * yt-dlp fails on HLS.
 */

export const NM3U8DL_BINARY = "N_m3u8DL-RE";

/** Media extensions we accept as the tool's output. */
export const HLS_OUTPUT_EXTENSIONS = ["mp4", "mkv", "ts", "m4a", "aac", "flv"] as const;

export function isHlsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return true;
    return /(^|[/_.-])hls([/_.-]|$)/i.test(path) && /\.(m3u8|m3u)$/i.test(path);
  } catch {
    return false;
  }
}

/**
 * `--select-video` / `--select-audio` instead of the blunt `--auto-select`.
 *
 * The tool matches with regular expressions and accepts a colon-separated list:
 *   `res=720*:range=SDR:codecs=hvc1:for=best`
 * Anything the user did not choose is simply omitted, so "best" always falls
 * back to the tool's own pick.
 */
export type HlsSelectOptions = {
  /** "720p" / "1080" / "best" — the requested height. */
  qualityLabel?: string | null;
  kind?: "video" | "audio";
  /** ISO language code for the audio track, e.g. "ar" / "en". */
  audioLang?: string | null;
  /** SDR / HDR (the tool also matches PQ/HLG through the same regex). */
  videoRange?: string | null;
  /** Codec regex, e.g. "hvc1", "avc1", "mp4a". */
  codecs?: string | null;
};

// ISO codes ("ar", "en-US") *and* the plain names some broadcasters put in
// LANGUAGE= ("Arabic", "English"). Only letters/hyphen, so it stays regex-safe.
const LANGUAGE_RE = /^[a-z]{2,20}(-[a-z0-9]{2,8})?$/i;
const RANGE_RE = /^(sdr|hdr|pq|hlg)$/i;
const CODECS_RE = /^[a-z0-9.\-]{2,24}$/i;

export function normalizeAudioLanguage(value: string | null | undefined): string | null {
  // Case is preserved on purpose: N_m3u8DL-RE matches `lang=` case-sensitively,
  // and manifests written by FFmpeg/real broadcasters use LANGUAGE="Arabic".
  const lang = (value ?? "").trim();
  return lang && LANGUAGE_RE.test(lang) ? lang : null;
}

/**
 * Map the requested language onto the exact spelling inside the manifest.
 *
 * `language: ar` in the UI vs `LANGUAGE="ar-SA"` / `LANGUAGE="Arabic"` in the
 * playlist is a real mismatch, and the tool then silently selects nothing. This
 * resolves case-insensitively and also accepts a prefix match ("ar" → "ar-SA").
 */
export function resolveAudioLanguage(manifestText: string, requested: string | null | undefined): string | null {
  const want = normalizeAudioLanguage(requested);
  if (!want) return null;
  const available = inspectHlsManifest(manifestText, "http://localhost/").audio
    .map((track) => track.language)
    .filter((language): language is string => Boolean(language));
  const lower = want.toLowerCase();
  const exact = available.find((language) => language.toLowerCase() === lower);
  if (exact) return exact;
  const prefix = available.find((language) => language.toLowerCase().startsWith(`${lower}-`) || language.toLowerCase().startsWith(lower));
  return prefix ?? want;
}

export function normalizeVideoRange(value: string | null | undefined): string | null {
  const range = (value ?? "").trim().toUpperCase();
  return range && RANGE_RE.test(range) ? range : null;
}

export function normalizeCodecs(value: string | null | undefined): string | null {
  const codecs = (value ?? "").trim().toLowerCase();
  return codecs && CODECS_RE.test(codecs) ? codecs : null;
}

/** `720p` → `720`; anything else → null. */
export function parseQualityHeight(qualityLabel: string | null | undefined): number | null {
  const label = (qualityLabel ?? "").trim().toLowerCase();
  const match = /^(\d{3,4})p?$/.exec(label);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 144 && value <= 4320 ? value : null;
}

export function buildHlsSelectArgs(
  options: HlsSelectOptions | string | null | undefined,
  kindArg?: "video" | "audio",
): string[] {
  // Back-compat with the two-argument form used earlier.
  const opts: HlsSelectOptions =
    typeof options === "string" || options === null || options === undefined
      ? { qualityLabel: options, kind: kindArg ?? "video" }
      : options;

  const kind = opts.kind ?? "video";
  const audioLang = normalizeAudioLanguage(opts.audioLang);
  const height = parseQualityHeight(opts.qualityLabel);
  const range = normalizeVideoRange(opts.videoRange);
  const codecs = normalizeCodecs(opts.codecs);

  const audioFilters = [audioLang ? `lang=${audioLang}` : null].filter(Boolean) as string[];
  const videoFilters = [
    height ? `res=${height}*` : null,
    range ? `range=${range}` : null,
    codecs ? `codecs=${codecs}` : null,
  ].filter(Boolean) as string[];

  if (kind === "audio") {
    if (audioFilters.length === 0) return ["--auto-select"];
    return ["--select-audio", [...audioFilters, "for=best"].join(":")];
  }

  if (videoFilters.length === 0 && audioFilters.length === 0) return ["--auto-select"];

  const args: string[] = [];
  if (videoFilters.length > 0) args.push("--select-video", [...videoFilters, "for=best"].join(":"));
  else args.push("--select-video", "for=best");
  args.push("--select-audio", [...audioFilters, "for=best"].join(":"));
  return args;
}

/** Attribute parser for `#EXT-X-STREAM-INF:` / `#EXT-X-MEDIA:` lines. */
export function parseHlsAttributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const body = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
  for (const match of body.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    const key = match[1];
    const raw = match[2] ?? "";
    result[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw.trim();
  }
  return result;
}

export type HlsVariant = {
  url: string;
  width: number | null;
  height: number | null;
  bandwidth: number | null;
  codecs: string | null;
  range: string | null;
  frameRate: number | null;
};

export type HlsAudioRendition = {
  groupId: string | null;
  name: string | null;
  language: string | null;
  isDefault: boolean;
  channels: string | null;
  uri: string | null;
};

export type HlsManifestInfo = {
  isMaster: boolean;
  variants: HlsVariant[];
  audio: HlsAudioRendition[];
  /** Encryption we refuse to touch (Widevine / FairPlay / AES-128 session keys). */
  drm: boolean;
  segmentCount: number;
};

/**
 * Read a master playlist so the UI can offer *real* choices (1920x1080 SDR,
 * Arabic audio…) instead of asking the user to type regexes.
 */
export function inspectHlsManifest(text: string, baseUrl: string): HlsManifestInfo {
  const lines = (text ?? "").split(/\r?\n/).map((line) => line.trim());
  const variants: HlsVariant[] = [];
  const audio: HlsAudioRendition[] = [];
  let isMaster = false;
  let segmentCount = 0;

  const absolute = (uri: string): string => {
    try {
      return new URL(uri, baseUrl).toString();
    } catch {
      return uri;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      isMaster = true;
      const attrs = parseHlsAttributes(line);
      const next = lines.slice(i + 1).find((candidate) => candidate && !candidate.startsWith("#")) ?? "";
      const [width, height] = (attrs.RESOLUTION ?? "").toLowerCase().split("x").map((part) => Number(part) || null);
      variants.push({
        url: next ? absolute(next) : "",
        width: width ?? null,
        height: height ?? null,
        bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) || null : null,
        codecs: attrs.CODECS ?? null,
        range: (attrs["VIDEO-RANGE"] ?? "").toUpperCase() || null,
        frameRate: attrs["FRAME-RATE"] ? Number(attrs["FRAME-RATE"]) || null : null,
      });
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseHlsAttributes(line);
      if ((attrs.TYPE ?? "").toUpperCase() !== "AUDIO") continue;
      audio.push({
        groupId: attrs["GROUP-ID"] ?? null,
        name: attrs.NAME ?? null,
        // Keep the manifest spelling: `--select-audio lang=` is case-sensitive.
        language: attrs.LANGUAGE ?? null,
        isDefault: (attrs.DEFAULT ?? "").toUpperCase() === "YES",
        channels: attrs.CHANNELS ?? null,
        uri: attrs.URI ? absolute(attrs.URI) : null,
      });
      continue;
    }
    // Key lines are inspected after the loop; nothing to collect here.
    if (line.startsWith("#EXTINF")) segmentCount += 1;
  }

  const drm = lines.some((line) => {
    if (!line.startsWith("#EXT-X-KEY:") && !line.startsWith("#EXT-X-SESSION-KEY:")) return false;
    const attrs = parseHlsAttributes(line);
    const method = (attrs.METHOD ?? "").toUpperCase();
    const keyFormat = (attrs.KEYFORMAT ?? "").toLowerCase();
    return (
      method.startsWith("SAMPLE-AES") ||
      keyFormat.includes("widevine") ||
      keyFormat.includes("fairplay") ||
      keyFormat.includes("playready")
    );
  });

  return { isMaster, variants, audio, drm, segmentCount };
}

/**
 * Parse a "Key: Value" block from the settings field. Rejects header injection
 * (CR/LF) and malformed names instead of passing them to the tool.
 */
export function parseHeaderLines(text: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) continue;
    if (!value || /[\r\n\t\x00-\x1f]/.test(value)) continue;
    headers[name] = value;
  }
  return headers;
}

/** `Cookie:` header for the target host, built from a Netscape cookies.txt. */
export function buildCookieHeader(content: string | null | undefined, url: string): string | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const pairs: string[] = [];
  for (const raw of (content ?? "").split(/\r?\n/)) {
    // `#HttpOnly_` prefixed lines are real cookies, not comments.
    const line = raw.trim().replace(/^#HttpOnly_/, "");
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const [domain, , , , , name, value] = fields;
    if (!name || value === undefined) continue;
    const bare = domain.replace(/^#HttpOnly_\.?/, "").replace(/^\./, "").toLowerCase();
    if (!bare) continue;
    if (!(host === bare || host.endsWith(`.${bare}`))) continue;
    pairs.push(`${name}=${value}`);
  }
  if (pairs.length === 0) return null;
  // Guard against header injection from a tampered cookies.txt.
  const header = pairs.join("; ");
  if (/[\r\n]/.test(header)) return null;
  return header;
}

export type HlsRequest = {
  url: string;
  outputDir: string;
  /** Without extension: the tool appends the container. */
  saveName: string;
  threadCount?: number;
  speedLimit?: string | null;
  ffmpegPath?: string | null;
  headers?: Record<string, string>;
  /** Keep subtitle tracks when the manifest has them. */
  subtitles?: boolean;
  /** Quality selection; empty/null means the tool picks the best track. */
  qualityLabel?: string | null;
  kind?: "video" | "audio";
  /** Preferred audio language (ISO code) for multi-audio manifests. */
  audioLang?: string | null;
  /** SDR / HDR / PQ / HLG filter. */
  videoRange?: string | null;
  /** Codec filter, e.g. "hvc1". */
  codecs?: string | null;
  /** Container for the final mux (mp4/mkv/ts) — omit to skip muxing. */
  muxFormat?: "mp4" | "mkv" | "ts" | null;
  /** Skip `--select-*` and let the tool auto-select (used for the fallback). */
  autoSelect?: boolean;
};

/**
 * Build the command line.
 *
 *  --force-ansi-console is required: without a TTY the tool crashes inside
 *  Spectre.Console ("Offset and length were out of bounds") — verified here, and
 *  the flag also makes it emit parseable progress lines.
 */
export function buildNm3u8dlArgs(request: HlsRequest): string[] {
  const args: string[] = [request.url];
  args.push("--save-dir", request.outputDir);
  args.push("--save-name", request.saveName);
  args.push("--tmp-dir", `${request.outputDir}/.nm3u8dl-tmp`);
  args.push("--thread-count", String(Math.min(32, Math.max(1, request.threadCount ?? 8))));
  args.push("--download-retry-count", "2");
  args.push("--http-request-timeout", "15");
  if (request.autoSelect) {
    args.push("--auto-select");
  } else {
    args.push(
      ...buildHlsSelectArgs({
        qualityLabel: request.qualityLabel,
        kind: request.kind ?? "video",
        audioLang: request.audioLang,
        videoRange: request.videoRange,
        codecs: request.codecs,
      }),
    );
  }
  args.push("--del-after-done");
  args.push("--check-segments-count");
  args.push("--no-log");
  args.push("--force-ansi-console");
  args.push("--ui-language", "en-US");
  if (request.ffmpegPath) args.push("--ffmpeg-binary-path", request.ffmpegPath);
  if (request.speedLimit) args.push("--max-speed", request.speedLimit);
  if (request.subtitles) args.push("--auto-subtitle-fix");
  // Without --mux-after-done, a master playlist that separates audio (EXT-X-MEDIA)
  // yields `video.mp4` *and* `audio.m4a` — the user expects one file. Verified
  // against a two-language fixture: muxing produces video+audio in one mp4.
  if (request.muxFormat) {
    args.push("--mux-after-done", `format=${request.muxFormat}:skip_sub=${request.subtitles ? "false" : "true"}`);
  }
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (!value) continue;
    // Header values are user/cookie derived: never allow a newline to break out.
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) continue;
    args.push("-H", `${key}: ${value}`);
  }
  return args;
}

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

export function parseSize(text: string | undefined): number | null {
  if (!text) return null;
  const match = text.match(/^([\d.]+)\s*([KMGTP]?B)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = SIZE_UNITS[match[2].toUpperCase()] ?? 1;
  return Number.isFinite(value) ? Math.round(value * unit) : null;
}

export type HlsProgress = {
  percent: number;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speed: string | null;
};

/**
 * One line of the tool's progress bar looks like:
 *   `Vid 1280x720 | 2320 Kbps ━━━ 12/41 29.27% 13.31MB/45.46MB5.55MBps00:00:05`
 */
export function parseNm3u8dlProgress(text: string): HlsProgress | null {
  const matches = [...(text ?? "").matchAll(/(\d{1,3}(?:\.\d+)?)%/g)];
  if (matches.length === 0) return null;
  const chunk = (text ?? "").slice(matches[matches.length - 1].index ?? 0);
  const percent = Number(matches[matches.length - 1][1]);
  if (!Number.isFinite(percent)) return null;

  const bytes = chunk.match(/([\d.]+[KMGTP]?B)\/([\d.]+[KMGTP]?B)\s*([\d.]+[KMGTP]?B)ps/i);
  return {
    percent: Math.min(99.9, Math.max(0, percent)),
    downloadedBytes: parseSize(bytes?.[1]),
    totalBytes: parseSize(bytes?.[2]),
    speed: bytes?.[3] ? `${bytes[3]}/s` : null,
  };
}

/**
 * DRM guard. We refuse Widevine/PlayReady/FairPlay and SAMPLE-AES manifests —
 * the same policy as the rest of the app (no DRM circumvention), and the tool
 * would only fail later anyway.
 */
export function looksLikeDrmManifest(text: string): boolean {
  const manifest = (text ?? "").toLowerCase();
  if (!manifest) return false;
  return (
    manifest.includes("sample-aes") ||
    manifest.includes("urn:uuid:edef8ba9") || // Widevine
    manifest.includes("urn:uuid:9a04f079") || // PlayReady
    manifest.includes("com.apple.streamingkeydelivery") || // FairPlay
    manifest.includes("skd://") ||
    manifest.includes("widevine") ||
    manifest.includes("playready")
  );
}

/**
 * Track-aware progress.
 *
 * The tool downloads tracks one after another (video, then audio, …) and each
 * one reaches 100%, so a naive percent makes the bar jump to 99.9% while half
 * the file is still missing. We therefore track how many tracks were selected
 * (`Selected streams:` block) and how many have started.
 */
export type HlsTrackState = { tracks: number; started: number; counting: boolean };

export function updateHlsTracks(state: HlsTrackState, line: string): HlsTrackState {
  const text = line ?? "";
  if (/Selected streams:/i.test(text)) return { ...state, counting: true };
  if (/Save Name:/i.test(text)) return { ...state, counting: false };
  if (state.counting && /(^|\s)(Vid|Aud|Sub)\s+\S+/i.test(text) && /INFO/.test(text)) {
    return { ...state, tracks: state.tracks + 1 };
  }
  if (/Reading media info|Start downloading/i.test(text)) {
    return { ...state, started: state.started + 1 };
  }
  return state;
}

/** Overall percentage across all selected tracks. */
export function overallHlsPercent(state: HlsTrackState, currentPercent: number): number {
  if (state.tracks > 1 && state.started > 0) {
    const index = Math.min(state.started, state.tracks);
    return Math.min(99.9, ((index - 1) + Math.max(0, Math.min(100, currentPercent)) / 100) / state.tracks * 100);
  }
  return Math.min(99.9, Math.max(0, currentPercent));
}

export const DRM_REFUSAL_MESSAGE =
  "هذا البث مشفّر بحماية DRM (Widevine/PlayReady/FairPlay أو SAMPLE-AES). التطبيق لا يتجاوز أي حماية تقنية — " +
  "استخدم الخدمة الرسمية للتنزيل. أُوقفت المهمة قبل تنزيل أي مقطع.";

/** The tool logs decryption errors when it hits DRM mid-flight. */
export function looksLikeDrmFailure(text: string): boolean {
  return /SAMPLE_AES|SAMPLE-AES|widevine|playready|fairplay|decrypt|unsupported.*encrypt/i.test(text ?? "");
}

export const HLS_FRIENDLY_ERRORS: [RegExp, string][] = [
  [
    /404|not found/i,
    "رابط m3u8 غير موجود (404). قد يكون الرابط مؤقتاً أو يحتاج ترويسات/كوكيز من الجلسة.",
  ],
  [
    /403|forbidden/i,
    "الخادم رفض الطلب (403) — يحتاج البث عادةً ترويسات Referer/Origin أو كوكيز جلسة.",
  ],
  [
    /Failed to parse|Invalid data/i,
    "تعذّر تحليل ملف m3u8 — تأكد أن الرابط هو رابط البث نفسه لا صفحة المشاهدة.",
  ],
];

/**
 * Permanent HLS failures. The tool words them as
 * `Response status code does not indicate success: 404 (Not Found).` and then
 * retries internally up to 10 times — we stop at the first one instead.
 */
export function isPermanentHlsFailure(text: string): boolean {
  return /does not indicate success: 40[13]|\(Not Found\)|\(Forbidden\)|Failed to parse|Invalid data/i.test(
    text ?? "",
  );
}

export function friendlyHlsError(raw: string): string {
  for (const [pattern, message] of HLS_FRIENDLY_ERRORS) if (pattern.test(raw ?? "")) return message;
  return `فشل تنزيل HLS: ${(raw ?? "").split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "سبب غير معروف"}`;
}

/** Filename the tool will produce (`<saveName>.<ext>`), matched after the run. */
export function isOutputFileFor(name: string, saveName: string): boolean {
  const base = name.toLowerCase();
  if (!base.startsWith(`${saveName.toLowerCase()}.`)) return false;
  return (HLS_OUTPUT_EXTENSIONS as readonly string[]).includes(base.split(".").pop() ?? "");
}

/** Sanitise a title into the `--save-name` value. */
export function safeSaveName(input: string): string {
  const cleaned = (input ?? "")
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return cleaned || "hls-video";
}
