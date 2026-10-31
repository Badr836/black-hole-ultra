import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Validation for paths that arrive from the settings API.
 *
 * The API used to accept *any* string for `ytdlpPath` / `ffmpegPath` /
 * `gallerydlPath` / `jsRuntimePath` (verified: `{"ffmpegPath":"/etc/passwd"}`
 * was accepted with `rejected: []`). A wrong value there is not a security hole
 * by itself, but it is a silent breakage: the engine spawns a non-executable file
 * and the user gets a confusing error much later. So: check existence, that it is
 * a regular file, and that it is executable (POSIX).
 */

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export type FsProbe = {
  exists: (file: string) => boolean;
  isFile: (file: string) => boolean;
  isExecutable: (file: string) => boolean;
  isReadable: (file: string) => boolean;
};

export function defaultProbe(platform: NodeJS.Platform = process.platform): FsProbe {
  return {
    exists: (file) => existsSync(file),
    isFile: (file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    },
    isExecutable: (file) => {
      // Windows has no POSIX exec bit: existence + a real file is the whole check.
      if (platform === "win32") return true;
      try {
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    isReadable: (file) => {
      try {
        accessSync(file, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function validateToolPath(value: string, probe: FsProbe = defaultProbe()): ValidationResult {
  const file = value.trim();
  if (!file) return { ok: true }; // empty = "auto-detect", always valid
  if (!probe.exists(file)) {
    return { ok: false, reason: "المسار غير موجود على هذا الجهاز." };
  }
  if (!probe.isFile(file)) {
    return { ok: false, reason: "المسار يشير إلى مجلد أو ملف خاص، وليس ملفاً تنفيذياً." };
  }
  if (!probe.isExecutable(file)) {
    return { ok: false, reason: "الملف موجود لكنه غير قابل للتنفيذ (chmod +x مطلوب)." };
  }
  return { ok: true };
}

export function validateReadableFile(value: string, probe: FsProbe = defaultProbe()): ValidationResult {
  const file = value.trim();
  if (!file) return { ok: true };
  if (!probe.exists(file)) return { ok: false, reason: "الملف غير موجود." };
  if (!probe.isFile(file)) return { ok: false, reason: "المسار ليس ملفاً." };
  if (!probe.isReadable(file)) return { ok: false, reason: "الملف موجود لكن لا صلاحية قراءة له." };
  return { ok: true };
}

/**
 * Resolve a path that may come from a config written on another OS.
 *
 * `path.resolve("C:\\ffmpeg\\bin\\ffmpeg.exe")` on Linux produces
 * `/srv/app/C:\ffmpeg\bin\ffmpeg.exe`, i.e. silently corrupts a Windows value
 * (and vice-versa). Detect the foreign form and normalise with the right module.
 */
export function resolveToolPath(value: string): string {
  const trimmed = value.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) {
    return path.win32.normalize(trimmed);
  }
  return path.resolve(trimmed);
}
