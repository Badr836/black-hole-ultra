import {
  isAudioContainer,
  isVideoContainer,
  type AudioContainer,
  type VideoContainer,
} from "./analyzer-normalize";

/**
 * Builds a yt-dlp -f selector string from the UI choice.
 * kind=video: merges best audio automatically (video-only + audio-only → ffmpeg merge).
 * kind=audio: audio-only, converted via ffmpeg to the chosen container.
 *
 * `mergeAudio: false` is used for progressive/direct formats that already carry
 * audio (the old code always appended `+bestaudio`, which forced an unnecessary
 * ffmpeg merge — and made direct file downloads impossible without ffmpeg).
 */
export function buildSelector(input: {
  kind: "video" | "audio" | "image";
  quality: string;
  container: string;
  audioFormatId?: string | null;
  mergeAudio?: boolean;
}): { selector: string; label: string } {
  const { kind, quality, container, audioFormatId, mergeAudio = true } = input;

  // Images / gallery posts are handled by gallery-dl; the selector is a marker.
  if (kind === "image") return { selector: "gallery", label: "الوسائط الأصلية" };

  if (kind === "audio") {
    if (quality.startsWith("id:")) {
      const id = sanitizeFormatId(quality.slice(3));
      return { selector: `${id}/bestaudio/best`, label: `audio ${id}` };
    }
    return { selector: "bestaudio/best", label: "أفضل صوت" };
  }

  const audio = audioFormatId ? `(${sanitizeFormatId(audioFormatId)}/bestaudio)` : "bestaudio";
  const withAudio = (video: string): string => (mergeAudio ? `${video}+${audio}/${video}/${video.replace(/\//g, "")}` : video);

  if (quality.startsWith("id:")) {
    const id = sanitizeFormatId(quality.slice(3));
    return { selector: withAudio(id), label: `format ${id}` };
  }

  const height = quality === "best" ? null : Number(quality);
  const hf = height && Number.isFinite(height) ? `[height<=${height}]` : "";
  let videoAlternatives: string;
  if (container === "mp4") {
    videoAlternatives = `bestvideo${hf}[vcodec^=avc1]/bestvideo${hf}[ext=mp4]/bestvideo${hf}`;
  } else if (container === "webm") {
    videoAlternatives = `bestvideo${hf}[ext=webm]/bestvideo${hf}[vcodec^=vp9]/bestvideo${hf}`;
  } else {
    videoAlternatives = `bestvideo${hf}`;
  }
  const selector = `(${videoAlternatives})+${audio}/best${hf}/best`;
  return { selector, label: height ? `${height}p` : "أفضل جودة" };
}

/** yt-dlp format ids are short alphanumeric tokens; anything else is a mistake. */
export function sanitizeFormatId(id: string): string {
  const clean = (id ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(clean)) {
    throw new Error("معرّف الصيغة غير صالح.");
  }
  return clean;
}

/** Fallback when ffmpeg is unavailable: single-file formats only (no merge/convert). */
export function noFfmpegSelector(kind: "video" | "audio" | "image", quality: string): string {
  if (kind === "audio") return "bestaudio[ext=m4a]/bestaudio/best";
  const height = quality === "best" || quality.startsWith("id:") ? null : Number(quality);
  const hf = height && Number.isFinite(height) ? `[height<=${height}]` : "";
  return `best${hf}[ext=mp4]/best${hf}[acodec!=none]/best${hf}/best`;
}

export function normalizeContainer(kind: "video" | "audio" | "image", container: string): string {
  const value = (container ?? "").trim().toLowerCase();
  if (kind === "image") {
    return /^[a-z0-9]{1,5}$/.test(value) ? value : "jpg";
  }
  if (kind === "audio") {
    return isAudioContainer(value) ? (value satisfies AudioContainer) : "m4a";
  }
  return isVideoContainer(value) ? (value satisfies VideoContainer) : "mp4";
}

/**
 * Whether this job truly needs FFmpeg/FFprobe.
 *
 * The old engine refused to start *any* job without ffmpeg, which made the
 * graceful no-ffmpeg branch in buildArgs unreachable dead code and blocked
 * plain single-file downloads that need no post-processing at all.
 */
export function needsFfmpeg(input: {
  kind: "video" | "audio" | "image";
  container: string;
  selector: string;
  subtitles?: boolean;
}): boolean {
  if (input.kind === "image") return false; // gallery-dl downloads originals
  if (input.subtitles) return true; // embedding subtitles/metadata needs ffmpeg
  if (input.kind === "audio") return true; // -x extraction/conversion always uses ffmpeg
  if (input.selector.includes("+")) return true; // merging streams
  if (["mkv", "webm"].includes(input.container)) return true; // remux/merge target
  return false;
}

/** Validate a yt-dlp `--playlist-items` spec such as "1-5,8,12-". */
export function sanitizePlaylistItems(spec: string | null | undefined): string | null {
  const value = (spec ?? "").replace(/\s+/g, "");
  if (!value) return null;
  if (!/^\d+(-\d*)?(,\d+(-\d*)?)*$/.test(value)) {
    throw new Error("صيغة عناصر قائمة التشغيل غير صالحة. مثال صحيح: 1-5,8,12-14");
  }
  return value;
}
