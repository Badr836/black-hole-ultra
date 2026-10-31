import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { currentVersion, migrate } from "./migrations";

export { currentVersion };

/**
 * Local-first database.
 *
 * The app previously required a running PostgreSQL server and a manual
 * `drizzle-kit push` before it would boot at all. Now a single SQLite file is
 * created (and migrated) automatically on first use.
 *
 * `BLACKHOLE_DB` overrides the location — used by the test suite.
 */
export function resolveDatabaseFile(): string {
  const override = process.env.BLACKHOLE_DB?.trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), "data", "blackhole.db");
}

type GlobalDb = typeof globalThis & {
  __bhSqlite?: Database.Database;
  __bhDb?: BetterSQLite3Database<Record<string, never>>;
  __bhMigrated?: boolean;
};

const g = globalThis as GlobalDb;

function open(): Database.Database {
  const file = resolveDatabaseFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const instance = new Database(file);
  instance.pragma("journal_mode = WAL");
  instance.pragma("busy_timeout = 5000");
  instance.pragma("synchronous = NORMAL");
  migrate(instance);
  return instance;
}

export const sqlite: Database.Database = g.__bhSqlite ?? open();

if (process.env.NODE_ENV !== "production" || !g.__bhSqlite) {
  g.__bhSqlite = sqlite;
}

export const db: BetterSQLite3Database<Record<string, never>> = g.__bhDb ?? drizzle(sqlite);

if (!g.__bhDb) g.__bhDb = db;

/** True when the database file is writable and migrated. Used by /api/health. */
export function dbHealthy(): boolean {
  try {
    sqlite.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}
