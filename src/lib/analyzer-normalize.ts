/**
 * Pure normalisation of `yt-dlp -J` output.
 *
 * Kept separate from `analyzer.ts` so it can be unit tested with fixtures and no
 * network / no child process. Adds the "direct file" fallback the old code was
 * missing: a plain media URL exposes `vcodec: null` and `height: null`, so both
 * the video branch and the audio branch skipped it and the UI showed "no
 * qualities available" for a perfectly downloadable file.
 */

export interface VideoOption {
  formatId: string;
  label: string;
  height: number;
  fps: number | null;
  ext: string;
  vcodec: string;
  filesize: number | null;
  tbr: number | null;
  hasAudio: boolean;
  /** True for direct files / progressive streams that need no audio merge. */
  single: boolean;
}

export interface AudioOption {
  formatId: string;
  label: string;
  ext: string;
  acodec: string;
  abr: number | null;
  filesize: number | null;
}

export type RawFormat = {
  format_id?: string | null;
  ext?: string | null;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  width?: number | null;
  fps?: number | null;
  tbr?: number | null;
  abr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  format_note?: string | null;
  protocol?: string | null;
};

export type RawInfo = {
  id?: string | null;
  title?: string | null;
  thumbnail?: string | null;
  thumbnails?: { url?: string | null }[];
  uploader?: string | null;
  channel?: string | null;
  duration?: number | null;
  webpage_url?: string | null;
  extractor_key?: string | null;
  _type?: string | null;
  entries?: RawInfo[] | null;
  playlist_count?: number | null;
  formats?: RawFormat[] | null;
  subtitles?: Record<string, unknown> | null;
  automatic_captions?: Record<string, unknown> | null;
};

export const QUALITY_PRESETS = [
  { value: "best", label: "أفضل جودة متاحة (تلقائي)", height: 0 },
  { value: "4320", label: "8K (4320p)", height: 4320 },
  { value: "2160", label: "4K (2160p)", height: 2160 },
  { value: "1440", label: "2K (1440p)", height: 1440 },
  { value: "1080", label: "Full HD (1080p)", height: 1080 },
  { value: "720", label: "HD (720p)", height: 720 },
  { value: "480", label: "SD (480p)", height: 480 },
  { value: "360", label: "360p", height: 360 },
] as const;

export const VIDEO_CONTAINERS = ["mp4", "mkv", "webm"] as const;
export const AUDIO_CONTAINERS = ["mp3", "m4a", "opus", "wav", "aac", "flac", "wma"] as const;

export type VideoContainer = (typeof VIDEO_CONTAINERS)[number];
export type AudioContainer = (typeof AUDIO_CONTAINERS)[number];

const VIDEO_MIME_EXT = new Set(["mp4", "mkv", "webm", "mov", "flv", "avi", "m4v", "ts", "3gp"]);
const AUDIO_MIME_EXT = new Set(["mp3", "m4a", "aac", "flac", "opus", "ogg", "wav", "wma"]);

export function isVideoContainer(value: string): value is VideoContainer {
  return (VIDEO_CONTAINERS as readonly string[]).includes(value);
}

export function isAudioContainer(value: string): value is AudioContainer {
  return (AUDIO_CONTAINERS as readonly string[]).includes(value);
}

export type NormalizedFormats = {
  videoOptions: VideoOption[];
  audioOptions: AudioOption[];
  /** Direct/progressive downloads used when no coded stream was detected. */
  directOptions: VideoOption[];
};

export function normalizeFormats(formats: RawFormat[] | null | undefined): NormalizedFormats {
  const list = Array.isArray(formats) ? formats : [];
  const videoOptions: VideoOption[] = [];
  const audioOptions: AudioOption[] = [];
  const directOptions: VideoOption[] = [];
  const seenVideo = new Set<string>();
  const seenAudio = new Set<string>();
  const seenDirect = new Set<string>();

  for (const format of list) {
    if (!format?.format_id) continue;
    const protocol = format.protocol ?? "";
    if (protocol.includes("mhtml")) continue; // storyboard / thumbnails
    const ext = (format.ext ?? "").toLowerCase();
    const hasVideo = Boolean(format.vcodec && format.vcodec !== "none");
    const hasAudio = Boolean(format.acodec && format.acodec !== "none");
    const size = format.filesize ?? format.filesize_approx ?? null;

    if (hasVideo && format.height) {
      const fps = format.fps ? Math.round(format.fps) : null;
      const key = `${format.height}-${fps ?? ""}-${ext}-${(format.vcodec ?? "").split(".")[0]}`;
      if (seenVideo.has(key)) continue;
      seenVideo.add(key);
      videoOptions.push({
        formatId: format.format_id,
        label: `${format.height}p${fps && fps > 30 ? fps : ""}`,
        height: format.height,
        fps,
        ext,
        vcodec: (format.vcodec ?? "").split(".")[0],
        filesize: size,
        tbr: format.tbr ?? null,
        hasAudio,
        single: hasAudio,
      });
      continue;
    }

    if (hasAudio && !hasVideo) {
      const abr = format.abr ?? format.tbr ?? null;
      const key = `${ext}-${(format.acodec ?? "").split(".")[0]}-${Math.round(abr ?? 0)}`;
      if (seenAudio.has(key)) continue;
      seenAudio.add(key);
      audioOptions.push({
        formatId: format.format_id,
        label: `${abr ? `${Math.round(abr)} kbps` : format.format_note ?? "audio"} · ${(format.acodec ?? "").split(".")[0]}`,
        ext,
        acodec: (format.acodec ?? "").split(".")[0],
        abr,
        filesize: size,
      });
      continue;
    }

    // Direct media file (plain mp4/mp3 URL, some HLS/DASH endpoints, generic
    // extractor results): yt-dlp reports no codec metadata at all.
    if (!hasVideo && !hasAudio && (VIDEO_MIME_EXT.has(ext) || AUDIO_MIME_EXT.has(ext))) {
      if (seenDirect.has(ext)) continue;
      seenDirect.add(ext);
      directOptions.push({
        formatId: format.format_id,
        label: `ملف مباشر (${ext.toUpperCase()})`,
        height: format.height ?? 0,
        fps: null,
        ext,
        vcodec: "",
        filesize: size,
        tbr: format.tbr ?? null,
        hasAudio: true,
        single: true,
      });
    }
  }

  videoOptions.sort(
    (a, b) => b.height - a.height || (b.fps ?? 0) - (a.fps ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0),
  );
  audioOptions.sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0));

  return { videoOptions, audioOptions, directOptions };
}

/** Best thumbnail available, preferring explicit entries over deprecated fields. */
export function pickThumbnail(target: RawInfo, root?: RawInfo): string | null {
  const candidates = [
    target.thumbnail,
    ...(target.thumbnails ?? []).map((t) => t?.url ?? null).reverse(),
    root?.thumbnail,
  ];
  for (const candidate of candidates) {
    if (candidate && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return null;
}

export function playlistEntries(info: RawInfo): { url: string; title: string }[] {
  const entries = Array.isArray(info.entries) ? info.entries : [];
  return entries
    .map((entry, index) => {
      const url = entry?.webpage_url ?? (entry?.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
      if (!url) return null;
      return { url, title: entry?.title ?? `عنصر ${index + 1}` };
    })
    .filter((entry): entry is { url: string; title: string } => entry !== null);
}
