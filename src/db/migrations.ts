import type { Database } from "better-sqlite3";

/**
 * Versioned migrations.
 *
 * Auto-DDL scattered across the code drifts from the schema; a numbered list
 * applied inside a transaction keeps upgrades reproducible and lets us add
 * columns later without wiping a user's queue.
 */
export type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-sqlite-schema",
    sql: `
      CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'Untitled',
        thumbnail TEXT,
        uploader TEXT,
        duration INTEGER,
        kind TEXT NOT NULL DEFAULT 'video',
        format_selector TEXT NOT NULL DEFAULT 'bestvideo+bestaudio/best',
        quality_label TEXT NOT NULL DEFAULT 'best',
        container TEXT NOT NULL DEFAULT 'mp4',
        subtitles INTEGER NOT NULL DEFAULT 0,
        playlist INTEGER NOT NULL DEFAULT 0,
        playlist_items TEXT,
        output_dir TEXT NOT NULL,
        file_name TEXT,
        file_path TEXT,
        files TEXT,
        completed_entries INTEGER,
        status TEXT NOT NULL DEFAULT 'queued',
        progress REAL NOT NULL DEFAULT 0,
        speed TEXT,
        eta TEXT,
        total_bytes INTEGER,
        downloaded_bytes INTEGER,
        retries INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        log TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS downloads_status_idx ON downloads (status);
      CREATE INDEX IF NOT EXISTS downloads_created_idx ON downloads (created_at);

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        max_concurrent INTEGER NOT NULL DEFAULT 3,
        output_dir TEXT NOT NULL,
        file_name_template TEXT NOT NULL DEFAULT '%(title)s [%(id)s].%(ext)s',
        max_retries INTEGER NOT NULL DEFAULT 3,
        speed_limit TEXT,
        embed_thumbnail INTEGER NOT NULL DEFAULT 1,
        embed_metadata INTEGER NOT NULL DEFAULT 1,
        allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
        ytdlp_path TEXT,
        ffmpeg_path TEXT,
        cookies_path TEXT,
        cookies_from_browser TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `,
  },
  {
    version: 2,
    name: "providers-and-gallery-dl",
    sql: `
      ALTER TABLE downloads ADD COLUMN provider TEXT;
      ALTER TABLE settings ADD COLUMN gallerydl_path TEXT;
      ALTER TABLE settings ADD COLUMN provider_preference TEXT NOT NULL DEFAULT 'auto';
    `,
  },
  {
    version: 3,
    name: "runtimes-downloader-archive-sponsorblock",
    sql: `
      ALTER TABLE settings ADD COLUMN js_runtime_path TEXT;
      ALTER TABLE settings ADD COLUMN external_downloader TEXT NOT NULL DEFAULT 'off';
      ALTER TABLE settings ADD COLUMN download_archive INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE settings ADD COLUMN sponsor_block TEXT NOT NULL DEFAULT 'off';
      ALTER TABLE settings ADD COLUMN concurrent_fragments INTEGER NOT NULL DEFAULT 4;
    `,
  },
  {
    version: 4,
    name: "hls-headers-and-cookies",
    sql: `
      ALTER TABLE settings ADD COLUMN hls_headers TEXT;
      ALTER TABLE settings ADD COLUMN hls_use_cookies INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 5,
    name: "hls-auto-headers-and-selection",
    sql: `
      ALTER TABLE settings ADD COLUMN hls_auto_headers INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE settings ADD COLUMN hls_audio_lang TEXT;
      ALTER TABLE settings ADD COLUMN hls_video_range TEXT;
      ALTER TABLE settings ADD COLUMN hls_codecs TEXT;
    `,
  },
  {
    // Direct-HTTP resume state + a stable failure taxonomy.
    // Everything is additive, so old rows and old code keep working.
    version: 6,
    name: "direct-resume-and-failure-code",
    sql: `
      ALTER TABLE downloads ADD COLUMN bytes_offset INTEGER;
      ALTER TABLE downloads ADD COLUMN temp_path TEXT;
      ALTER TABLE downloads ADD COLUMN etag TEXT;
      ALTER TABLE downloads ADD COLUMN last_modified TEXT;
      ALTER TABLE downloads ADD COLUMN resume_supported INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE downloads ADD COLUMN failure_code TEXT;
    `,
  },
];

export function currentVersion(sqlite: Database): number {
  sqlite.exec("CREATE TABLE IF NOT EXISTS __meta (version INTEGER NOT NULL)");
  const row = sqlite.prepare("SELECT version FROM __meta LIMIT 1").get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

/** Apply every pending migration in order. Safe to call on every boot. */
export function migrate(sqlite: Database): { from: number; to: number; applied: string[] } {
  const from = currentVersion(sqlite);
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    const run = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      if (applied.length === 0 && from === 0) {
        sqlite.prepare("INSERT INTO __meta (version) VALUES (?)").run(0);
      }
      sqlite.prepare("UPDATE __meta SET version = ?").run(migration.version);
    });
    run();
    applied.push(`${migration.version}:${migration.name}`);
  }

  return { from, to: currentVersion(sqlite), applied };
}
