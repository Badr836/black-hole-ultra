import path from "node:path";
import os from "node:os";
import { mkdirSync, realpathSync } from "node:fs";

/**
 * Path safety helpers.
 *
 * A local downloader is designed to be reachable from other devices on the LAN
 * (see README), so every filesystem path that arrives from a request body or
 * from the settings table must be validated before it is used for writing or
 * for serving a file. Rules:
 *   - no NUL bytes, no "~" expansion surprises;
 *   - the resolved path must live inside one of the allowed roots;
 *   - symlinks are resolved before the containment check.
 */

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

export function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** Real path when it exists, absolute lexical path otherwise (for not-yet-created dirs). */
export function safeReal(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(safeReal(parent), safeReal(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Roots a download may write into. `DOWNLOAD_DIR` and the folder the user
 * explicitly saved in settings are always allowed; otherwise we fall back to
 * the home directory and the OS temp dir so a fresh install just works.
 */
export function allowedRoots(extra: Array<string | null | undefined> = []): string[] {
  const roots = [
    process.env.DOWNLOAD_DIR,
    ...extra,
    path.join(os.homedir(), "Downloads"),
    os.homedir(),
    os.tmpdir(),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    if (!root || !root.trim()) continue;
    const resolved = path.resolve(expandHome(root));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function isInsideAnyRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => isInside(target, root));
}

/**
 * Validate a requested output directory.
 * `requested` may be empty (use the fallback), relative (joined to the fallback)
 * or absolute (must still be inside an allowed root).
 */
export function resolveOutputDir(
  requested: string | null | undefined,
  fallback: string,
  roots: string[] = allowedRoots(),
): PathCheck {
  const fallbackResolved = path.resolve(expandHome(fallback || os.homedir()));
  const raw = (requested ?? "").trim();
  if (raw.includes("\0")) return { ok: false, reason: "المسار يحتوي محرفاً غير صالح (NUL)." };

  const expanded = expandHome(raw);
  const candidate = !raw
    ? fallbackResolved
    : path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(fallbackResolved, expanded);
  if (!path.isAbsolute(candidate)) {
    return { ok: false, reason: "المسار غير مطلق بعد التحويل؛ أدخل مساراً صالحاً." };
  }
  const allowed = roots.length > 0 ? roots : allowedRoots();
  if (!isInsideAnyRoot(candidate, allowed)) {
    return {
      ok: false,
      reason: `مجلد الحفظ خارج الجذور المسموحة (${allowed.join("، ")}).`,
    };
  }
  try {
    mkdirSync(candidate, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      reason: `تعذّر إنشاء مجلد الحفظ: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, path: candidate };
}

/**
 * Sanitise the yt-dlp output template. The template is user editable, so a
 * value such as `../../etc/x` or `/etc/x` would let a download escape the
 * output directory. We keep yt-dlp placeholders (%(title)s …) but strip path
 * separators and any parent-directory segment from the literal parts.
 */
export function sanitizeFileNameTemplate(template: string, fallback = "%(title)s [%(id)s].%(ext)s"): string {
  const raw = (template ?? "").replace(/\0/g, "").trim();
  if (!raw) return fallback;
  // Work segment by segment: drop "", "." and ".." so neither traversal nor an
  // absolute path can survive, then join the pieces with "_".
  const cleaned = raw
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("_")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) return fallback;
  // A template must keep the extension placeholder to produce usable files.
  return /%\(ext\)s/.test(cleaned) ? cleaned : `${cleaned}.%(ext)s`;
}

/** True when a path may be served/streamed back to the client. */
export function isServableFile(filePath: string | null | undefined, roots: string[]): boolean {
  if (!filePath || filePath.includes("\0")) return false;
  const resolved = path.resolve(filePath);
  return isInsideAnyRoot(resolved, roots);
}

export function formatFreeSpace(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
