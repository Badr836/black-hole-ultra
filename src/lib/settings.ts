import { db } from "@/db";
import { settings, type Settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { allowedRoots, resolveOutputDir, sanitizeFileNameTemplate } from "./safe-path";
import { resolveToolPath, validateReadableFile, validateToolPath, type FsProbe } from "./validate";
import { normalizeAudioLanguage, normalizeCodecs, normalizeVideoRange } from "./hls";

export const COOKIE_BROWSERS = [
  "",
  "chrome",
  "edge",
  "firefox",
  "brave",
  "opera",
  "vivaldi",
  "safari",
] as const;

export function defaultOutputDir(): string {
  const dir = process.env.DOWNLOAD_DIR?.trim() || path.join(os.homedir(), "Downloads", "BlackHole");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* diagnostics report permission failures */
  }
  return dir;
}

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(settings).limit(1);
  const existing = rows[0];
  if (existing) {
    try {
      mkdirSync(existing.outputDir, { recursive: true });
    } catch {
      /* ignore */
    }
    return existing;
  }
  const [created] = await db
    .insert(settings)
    .values({ outputDir: defaultOutputDir(), updatedAt: new Date() })
    .returning();
  return created;
}

export type SettingsPatch = Partial<Omit<Settings, "id" | "updatedAt">>;

/**
 * Validate + coerce an untrusted settings payload.
 * Returns the accepted patch and a list of rejected field names so the UI can
 * explain what happened instead of silently ignoring input.
 */
export function coerceSettingsPatch(
  body: Record<string, unknown>,
  currentOutputDir: string,
  options: { probe?: FsProbe } = {},
): { patch: SettingsPatch; rejected: string[]; reasons: Record<string, string> } {
  const patch: SettingsPatch = {};
  const rejected: string[] = [];
  const reasons: Record<string, string> = {};

  if (body.maxConcurrent !== undefined) {
    if (typeof body.maxConcurrent === "number" && Number.isFinite(body.maxConcurrent)) {
      patch.maxConcurrent = Math.min(16, Math.max(1, Math.trunc(body.maxConcurrent)));
    } else rejected.push("maxConcurrent");
  }
  if (body.maxRetries !== undefined) {
    if (typeof body.maxRetries === "number" && Number.isFinite(body.maxRetries)) {
      patch.maxRetries = Math.min(10, Math.max(0, Math.trunc(body.maxRetries)));
    } else rejected.push("maxRetries");
  }
  if (body.outputDir !== undefined) {
    if (typeof body.outputDir === "string") {
      const check = resolveOutputDir(body.outputDir, currentOutputDir, allowedRoots([currentOutputDir]));
      if (check.ok) patch.outputDir = check.path;
      else rejected.push("outputDir");
    } else rejected.push("outputDir");
  }
  if (body.fileNameTemplate !== undefined) {
    if (typeof body.fileNameTemplate === "string") {
      patch.fileNameTemplate = sanitizeFileNameTemplate(body.fileNameTemplate);
    } else rejected.push("fileNameTemplate");
  }
  if (body.embedThumbnail !== undefined) {
    if (typeof body.embedThumbnail === "boolean") patch.embedThumbnail = body.embedThumbnail;
    else rejected.push("embedThumbnail");
  }
  if (body.embedMetadata !== undefined) {
    if (typeof body.embedMetadata === "boolean") patch.embedMetadata = body.embedMetadata;
    else rejected.push("embedMetadata");
  }
  if (body.allowInsecureTls !== undefined) {
    if (typeof body.allowInsecureTls === "boolean") patch.allowInsecureTls = body.allowInsecureTls;
    else rejected.push("allowInsecureTls");
  }
  if (body.speedLimit !== undefined) {
    if (typeof body.speedLimit === "string") {
      const value = body.speedLimit.trim();
      patch.speedLimit = value && /^\d+(\.\d+)?[KMG]?$/i.test(value) ? value : null;
      if (value && !patch.speedLimit) rejected.push("speedLimit");
    } else rejected.push("speedLimit");
  }
  if (body.providerPreference !== undefined) {
    if (
      body.providerPreference === "auto" ||
      body.providerPreference === "ytdlp" ||
      body.providerPreference === "gallerydl" ||
      body.providerPreference === "nm3u8dl"
    ) {
      patch.providerPreference = body.providerPreference;
    } else rejected.push("providerPreference");
  }
  if (body.jsRuntimePath !== undefined) {
    if (typeof body.jsRuntimePath === "string" || body.jsRuntimePath === null) {
      const value = String(body.jsRuntimePath ?? "").trim();
      const check = validateToolPath(value, options.probe);
      if (check.ok) patch.jsRuntimePath = value ? resolveToolPath(value) : null;
      else {
        rejected.push("jsRuntimePath");
        reasons.jsRuntimePath = check.reason;
      }
    } else rejected.push("jsRuntimePath");
  }
  if (body.externalDownloader !== undefined) {
    if (body.externalDownloader === "off" || body.externalDownloader === "aria2c") {
      patch.externalDownloader = body.externalDownloader;
    } else rejected.push("externalDownloader");
  }
  if (body.hlsHeaders !== undefined) {
    if (typeof body.hlsHeaders === "string" || body.hlsHeaders === null) {
      // Normalise but keep the raw text: it is validated again when building args.
      const value = String(body.hlsHeaders ?? "").trim();
      patch.hlsHeaders = value ? value.slice(0, 2_000) : null;
    } else rejected.push("hlsHeaders");
  }
  if (body.hlsUseCookies !== undefined) {
    if (typeof body.hlsUseCookies === "boolean") patch.hlsUseCookies = body.hlsUseCookies;
    else rejected.push("hlsUseCookies");
  }
  if (body.hlsAutoHeaders !== undefined) {
    if (typeof body.hlsAutoHeaders === "boolean") patch.hlsAutoHeaders = body.hlsAutoHeaders;
    else rejected.push("hlsAutoHeaders");
  }
  if (body.hlsAudioLang !== undefined) {
    if (typeof body.hlsAudioLang === "string" || body.hlsAudioLang === null) {
      const raw = String(body.hlsAudioLang ?? "").trim();
      const value = normalizeAudioLanguage(raw);
      if (raw && !value) {
        rejected.push("hlsAudioLang");
        reasons.hlsAudioLang = "رمز اللغة غير صالح — استخدم رمزاً مثل ar أو en أو fr.";
      } else patch.hlsAudioLang = value;
    } else rejected.push("hlsAudioLang");
  }
  if (body.hlsVideoRange !== undefined) {
    if (typeof body.hlsVideoRange === "string" || body.hlsVideoRange === null) {
      const raw = String(body.hlsVideoRange ?? "").trim();
      const value = normalizeVideoRange(raw);
      if (raw && !value) {
        rejected.push("hlsVideoRange");
        reasons.hlsVideoRange = "المدى غير معروف — القيم المقبولة: SDR أو HDR أو PQ أو HLG.";
      } else patch.hlsVideoRange = value;
    } else rejected.push("hlsVideoRange");
  }
  if (body.hlsCodecs !== undefined) {
    if (typeof body.hlsCodecs === "string" || body.hlsCodecs === null) {
      const raw = String(body.hlsCodecs ?? "").trim();
      const value = normalizeCodecs(raw);
      if (raw && !value) {
        rejected.push("hlsCodecs");
        reasons.hlsCodecs = "اسم الترميز غير صالح — مثال: hvc1 أو avc1.";
      } else patch.hlsCodecs = value;
    } else rejected.push("hlsCodecs");
  }
  if (body.downloadArchive !== undefined) {
    if (typeof body.downloadArchive === "boolean") patch.downloadArchive = body.downloadArchive;
    else rejected.push("downloadArchive");
  }
  if (body.sponsorBlock !== undefined) {
    if (body.sponsorBlock === "off" || body.sponsorBlock === "mark" || body.sponsorBlock === "remove") {
      patch.sponsorBlock = body.sponsorBlock;
    } else rejected.push("sponsorBlock");
  }
  if (body.concurrentFragments !== undefined) {
    if (typeof body.concurrentFragments === "number" && Number.isFinite(body.concurrentFragments)) {
      patch.concurrentFragments = Math.min(16, Math.max(1, Math.trunc(body.concurrentFragments)));
    } else rejected.push("concurrentFragments");
  }
  for (const key of ["ytdlpPath", "ffmpegPath", "gallerydlPath"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] === "string" || body[key] === null) {
        const value = String(body[key] ?? "").trim();
        const check = validateToolPath(value, options.probe);
        if (check.ok) patch[key] = value ? resolveToolPath(value) : null;
        else {
          rejected.push(key);
          reasons[key] = check.reason;
        }
      } else rejected.push(key);
    }
  }
  if (body.cookiesPath !== undefined) {
    if (typeof body.cookiesPath === "string" || body.cookiesPath === null) {
      const value = String(body.cookiesPath ?? "").trim();
      const check = validateReadableFile(value, options.probe);
      if (check.ok) patch.cookiesPath = value ? resolveToolPath(value) : null;
      else {
        rejected.push("cookiesPath");
        reasons.cookiesPath = check.reason;
      }
    } else rejected.push("cookiesPath");
  }
  if (body.cookiesFromBrowser !== undefined) {
    if (typeof body.cookiesFromBrowser === "string" || body.cookiesFromBrowser === null) {
      const value = String(body.cookiesFromBrowser ?? "").trim();
      patch.cookiesFromBrowser = (COOKIE_BROWSERS as readonly string[]).includes(value) && value
        ? value
        : null;
      if (value && !patch.cookiesFromBrowser) rejected.push("cookiesFromBrowser");
    } else rejected.push("cookiesFromBrowser");
  }

  return { patch, rejected, reasons };
}

export async function updateSettings(
  patch: SettingsPatch | Record<string, unknown>,
): Promise<Settings> {
  const current = await getSettings();
  const { patch: clean } = coerceSettingsPatch(
    patch as Record<string, unknown>,
    current.outputDir,
  );
  const [updated] = await db
    .update(settings)
    .set({ ...clean, updatedAt: new Date() })
    .where(eq(settings.id, current.id))
    .returning();
  if (updated?.outputDir) {
    try {
      mkdirSync(updated.outputDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return updated ?? current;
}

const BACKUP_KEYS = [
  "maxConcurrent",
  "outputDir",
  "fileNameTemplate",
  "maxRetries",
  "speedLimit",
  "embedThumbnail",
  "embedMetadata",
  "allowInsecureTls",
  "cookiesFromBrowser",
  "providerPreference",
  "externalDownloader",
  "downloadArchive",
  "sponsorBlock",
  "concurrentFragments",
] as const;

export type SettingsBackup = {
  app: "blackhole-ultra";
  version: 1;
  exportedAt: string;
  payload: Record<string, unknown>;
};

/** Portable backup: excludes machine-specific executable paths. */
export async function exportSettings(): Promise<SettingsBackup> {
  const current = await getSettings();
  const payload: Record<string, unknown> = {};
  for (const key of BACKUP_KEYS) payload[key] = current[key];
  return {
    app: "blackhole-ultra",
    version: 1,
    exportedAt: new Date().toISOString(),
    payload,
  };
}

export function parseBackup(raw: unknown): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "ملف النسخة الاحتياطية غير صالح." };
  const obj = raw as Record<string, unknown>;
  const candidate = obj.app === "blackhole-ultra" && obj.payload && typeof obj.payload === "object"
    ? (obj.payload as Record<string, unknown>)
    : obj;
  const hasKnownKey = BACKUP_KEYS.some((key) => candidate[key] !== undefined);
  if (!hasKnownKey) return { ok: false, reason: "لا يحتوي الملف على أي إعداد معروف." };
  return { ok: true, payload: candidate };
}
