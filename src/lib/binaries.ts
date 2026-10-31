import { execFile } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const isWin = process.platform === "win32";

function candidates(name: string, envVar: string, override?: string | null): string[] {
  const exe = isWin ? `${name}.exe` : name;
  const list: string[] = [];
  if (override) list.push(override);
  if (process.env[envVar]) list.push(process.env[envVar] as string);
  list.push(path.join(process.cwd(), "bin", exe));
  list.push(path.join(os.homedir(), ".local", "bin", exe));
  if (isWin) {
    list.push(path.join(process.env.LOCALAPPDATA ?? "", "Programs", "BlackHole", exe));
    list.push(`C:\\ffmpeg\\bin\\${exe}`);
  } else {
    list.push(`/usr/local/bin/${exe}`, `/usr/bin/${exe}`, `/opt/homebrew/bin/${exe}`);
  }
  return list;
}

function whichSync(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const exts = isWin ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (dir && existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * The bundled `bin/` folder is restored from archives/snapshots that do not
 * always keep the POSIX exec bit (seen on this machine: `bin/N_m3u8DL-RE` came
 * back as 0644 and the engine failed with EACCES). Fixing the mode of *our own*
 * shipped binaries is safe and saves the user a confusing error.
 * User-supplied paths are never touched — they are validated instead.
 */
export function ensureExecutable(file: string): boolean {
  if (isWin) return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    /* not executable yet */
  }
  try {
    if (!statSync(file).isFile()) return false;
    chmodSync(file, 0o755);
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type BinaryName = "yt-dlp" | "ffmpeg" | "ffprobe" | "gallery-dl" | "aria2c" | "N_m3u8DL-RE";

export function resolveBinary(name: BinaryName, override?: string | null): string | null {
  const envVar =
    name === "yt-dlp"
      ? "YTDLP_PATH"
      : name === "ffmpeg"
        ? "FFMPEG_PATH"
        : name === "ffprobe"
          ? "FFPROBE_PATH"
          : name === "aria2c"
            ? "ARIA2C_PATH"
            : name === "N_m3u8DL-RE"
              ? "NM3U8DL_RE_PATH"
              : "GALLERYDL_PATH";
  const bundled = path.join(process.cwd(), "bin", isWin ? `${name}.exe` : name);
  for (const c of candidates(name, envVar, override)) {
    if (!c || !existsSync(c)) continue;
    // Only the bundled copy is auto-fixed; overrides belong to the user.
    if (c === bundled) ensureExecutable(c);
    return c;
  }
  return whichSync(name);
}

export function runBinary(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs ?? 90_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error & { stdout?: string; stderr?: string };
          reject(new Error(stderr?.toString().trim() || e.message));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

export async function binaryVersion(bin: string | null, args: string[]): Promise<string | null> {
  if (!bin) return null;
  try {
    const { stdout, stderr } = await runBinary(bin, args, { timeoutMs: 15_000 });
    const out = (stdout || stderr).split(/\r?\n/)[0]?.trim();
    return out || "unknown";
  } catch {
    return null;
  }
}
