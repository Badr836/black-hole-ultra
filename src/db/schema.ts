import { sqliteTable, integer, text, real, index } from "drizzle-orm/sqlite-core";

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "converting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "missing";

/** "image" covers gallery-dl photo posts (Instagram/Pinterest/X images). */
export type MediaKind = "video" | "audio" | "image";

export type ProviderId = "ytdlp" | "gallerydl" | "nm3u8dl" | "http";

/**
 * Local-first storage. SQLite (better-sqlite3) replaces PostgreSQL so the app
 * runs with `npm run dev` on any machine — no external database service, which
 * is the whole point of a private local download manager.
 *
 * Column mapping notes:
 *  - `bigint` → integer (SQLite integers are 64-bit; JS safe up to 2^53 bytes).
 *  - `jsonb`  → text with `{ mode: "json" }`.
 *  - `timestamp` → integer with `{ mode: "timestamp_ms" }` (maps to JS Date).
 */
export const downloads = sqliteTable(
  "downloads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    url: text("url").notNull(),
    title: text("title").notNull().default("Untitled"),
    thumbnail: text("thumbnail"),
    uploader: text("uploader"),
    duration: integer("duration"),
    kind: text("kind").$type<MediaKind>().notNull().default("video"),
    formatSelector: text("format_selector").notNull().default("bestvideo+bestaudio/best"),
    qualityLabel: text("quality_label").notNull().default("best"),
    container: text("container").notNull().default("mp4"),
    /** Which engine handled (or should handle) this job. */
    provider: text("provider").$type<ProviderId>(),
    subtitles: integer("subtitles", { mode: "boolean" }).notNull().default(false),
    playlist: integer("playlist", { mode: "boolean" }).notNull().default(false),
    playlistItems: text("playlist_items"),
    outputDir: text("output_dir").notNull(),
    fileName: text("file_name"),
    filePath: text("file_path"),
    /** All produced files (playlists produce many); `filePath` is the primary one. */
    files: text("files", { mode: "json" }).$type<string[] | null>(),
    completedEntries: integer("completed_entries"),
    status: text("status").$type<DownloadStatus>().notNull().default("queued"),
    progress: real("progress").notNull().default(0),
    speed: text("speed"),
    eta: text("eta"),
    totalBytes: integer("total_bytes"),
    downloadedBytes: integer("downloaded_bytes"),
    retries: integer("retries").notNull().default(0),
    error: text("error"),
    /**
     * Direct-HTTP resume state (migration 6). `bytesOffset` is the last byte
     * actually written to `tempPath`; `etag`/`lastModified` are the validators
     * captured with those bytes, used to refuse a resume against changed content.
     */
    bytesOffset: integer("bytes_offset"),
    tempPath: text("temp_path"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    resumeSupported: integer("resume_supported", { mode: "boolean" }).notNull().default(false),
    /** Stable code from lib/failure-reason (why it failed, not just that it did). */
    failureCode: text("failure_code"),
    log: text("log"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown> | null>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("downloads_status_idx").on(table.status),
    index("downloads_created_idx").on(table.createdAt),
  ],
);

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  maxConcurrent: integer("max_concurrent").notNull().default(3),
  outputDir: text("output_dir").notNull(),
  fileNameTemplate: text("file_name_template").notNull().default("%(title)s [%(id)s].%(ext)s"),
  maxRetries: integer("max_retries").notNull().default(3),
  speedLimit: text("speed_limit"),
  embedThumbnail: integer("embed_thumbnail", { mode: "boolean" }).notNull().default(true),
  embedMetadata: integer("embed_metadata", { mode: "boolean" }).notNull().default(true),
  /** Off by default: disabling TLS verification is a deliberate, documented choice. */
  allowInsecureTls: integer("allow_insecure_tls", { mode: "boolean" }).notNull().default(false),
  ytdlpPath: text("ytdlp_path"),
  ffmpegPath: text("ffmpeg_path"),
  gallerydlPath: text("gallerydl_path"),
  /** auto = route by URL; or force a provider. */
  providerPreference: text("provider_preference").$type<ProviderId | "auto">().notNull().default("auto"),
  cookiesPath: text("cookies_path"),
  cookiesFromBrowser: text("cookies_from_browser"),
  /** Explicit JS runtime (deno/bun/node) path; empty = auto-detect. */
  jsRuntimePath: text("js_runtime_path"),
  /** External downloader: off (default) | aria2c (http protocol only). */
  externalDownloader: text("external_downloader").$type<"off" | "aria2c">().notNull().default("off"),
  /** Skip media already recorded in the per-folder archive file. */
  downloadArchive: integer("download_archive", { mode: "boolean" }).notNull().default(false),
  /** SponsorBlock: off (default) | mark | remove — sends the video id to a third party. */
  sponsorBlock: text("sponsor_block").$type<"off" | "mark" | "remove">().notNull().default("off"),
  /** Parallel fragment downloads (was hard-coded to 8). */
  concurrentFragments: integer("concurrent_fragments").notNull().default(4),
  /** Extra request headers for HLS ("Referer: …" per line) — session-protected streams. */
  hlsHeaders: text("hls_headers"),
  /** Send the stored cookies.txt entries as a Cookie header to the HLS engine. */
  hlsUseCookies: integer("hls_use_cookies", { mode: "boolean" }).notNull().default(true),
  /** Probe user → watch page → same-origin headers automatically instead of guessing once. */
  hlsAutoHeaders: integer("hls_auto_headers", { mode: "boolean" }).notNull().default(true),
  /** Default audio language for multi-audio HLS (ISO code, e.g. "ar"). */
  hlsAudioLang: text("hls_audio_lang"),
  /** Default video-range filter: SDR / HDR / PQ / HLG. */
  hlsVideoRange: text("hls_video_range"),
  /** Default codec filter (e.g. "hvc1"). */
  hlsCodecs: text("hls_codecs"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type Download = typeof downloads.$inferSelect;
export type NewDownload = typeof downloads.$inferInsert;
export type Settings = typeof settings.$inferSelect;
