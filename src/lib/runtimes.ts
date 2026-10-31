import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { ensureExecutable } from "./binaries";
import os from "node:os";
import path from "node:path";

/**
 * JavaScript runtime detection (yt-dlp issue #15012 / #16766 / #17799).
 *
 * YouTube's player now needs a JS runtime to solve its `n`/signature
 * challenges. yt-dlp can use Deno, Bun or Node — but only *if it can find one*,
 * and Node below 22 is rejected (`node-20.x (unsupported)`). Most "formats
 * missing / 403 on YouTube" reports are this, not a broken extractor.
 *
 * We therefore detect the runtime ourselves, tell the user exactly what is
 * missing, and pass `--js-runtimes` only when a *supported* runtime exists.
 */

export type JsRuntimeName = "deno" | "bun" | "node";

/** Narrow env shape so tests can pass `{ PATH: "…" }` without NODE_ENV. */
export type EnvLike = Record<string, string | undefined>;

export type JsRuntimeInfo = {
  name: JsRuntimeName;
  path: string;
  version: string | null;
  supported: boolean;
  /** Why it was rejected (shown in diagnostics). */
  reason: string | null;
};

/** Preference order: Deno has the fastest cold start and is yt-dlp's default. */
export const JS_RUNTIME_PRIORITY: JsRuntimeName[] = ["deno", "bun", "node"];

/** yt-dlp 2026.x rejects Node 20; Node 22+ is the first fully supported line. */
export const MIN_NODE_MAJOR = 22;

const BIN: Record<JsRuntimeName, string> = { deno: "deno", bun: "bun", node: "node" };

/** Where each runtime usually lives when it is *not* on PATH. */
export function candidatePaths(
  name: JsRuntimeName,
  env: EnvLike = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const exe = platform === "win32" ? `${BIN[name]}.exe` : BIN[name];
  const out: string[] = [];
  const push = (p?: string | null) => {
    if (p && !out.includes(p)) out.push(p);
  };

  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (dir.trim()) push(path.join(dir.trim(), exe));
  }

  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (name === "deno") push(local && path.join(local, "deno", exe));
    if (name === "bun") push(local && path.join(local, "bun", exe));
    if (name === "node") push(env.ProgramFiles && path.join(env.ProgramFiles, "nodejs", exe));
  } else {
    if (name === "deno") push(path.join(home, ".deno", "bin", exe));
    if (name === "bun") push(path.join(home, ".bun", "bin", exe));
    if (name === "node") {
      push("/usr/local/bin/node");
      push("/opt/homebrew/bin/node");
      push(path.join(home, ".local", "bin", "node"));
    }
    push("/usr/bin/" + BIN[name]);
    push("/usr/local/bin/" + BIN[name]);
  }
  return out;
}

/** `v22.11.0` → 22, `node-20.20.2` → 20. Returns null when unparseable. */
export function parseMajor(version: string | null | undefined): number | null {
  if (!version) return null;
  const match = version.match(/(\d+)\.\d+/);
  return match ? Number(match[1]) : null;
}

export function isRuntimeSupported(name: JsRuntimeName, version: string | null): boolean {
  if (!version) return false;
  const major = parseMajor(version);
  if (name === "node") return major !== null && major >= MIN_NODE_MAJOR;
  return major !== null;
}

export function rejectionReason(name: JsRuntimeName, version: string | null): string | null {
  if (!version) return "لم يُقرأ إصداره";
  if (name === "node" && !isRuntimeSupported(name, version)) {
    return `Node ${parseMajor(version) ?? "?"} غير مدعوم — yt-dlp يحتاج Node ${MIN_NODE_MAJOR}+ (استخدم Deno بدلاً منه)`;
  }
  return null;
}

/** First supported runtime in preference order. */
export function pickJsRuntime(list: JsRuntimeInfo[]): JsRuntimeInfo | null {
  for (const name of JS_RUNTIME_PRIORITY) {
    const hit = list.find((item) => item.name === name && item.supported);
    if (hit) return hit;
  }
  return null;
}

/**
 * Build `--js-runtimes` arguments.
 *
 * - nothing detected → no argument at all (never break the download)
 * - detected on PATH → `deno` (yt-dlp resolves it)
 * - detected off PATH (e.g. ~/.deno/bin) → `deno:/abs/path/deno`
 */
export function jsRuntimeArgs(
  runtime: { name: JsRuntimeName; path: string } | null,
  overridePath?: string | null,
  env: EnvLike = process.env,
): string[] {
  const override = overridePath?.trim();
  if (override) {
    const name = detectNameFromPath(override);
    return ["--js-runtimes", `${name}:${override}`];
  }
  if (!runtime) return [];
  const dir = path.dirname(runtime.path);
  const onPath = (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .some((entry) => entry.trim() && path.resolve(entry.trim()) === path.resolve(dir));
  return ["--js-runtimes", onPath ? runtime.name : `${runtime.name}:${runtime.path}`];
}

export function detectNameFromPath(file: string): JsRuntimeName {
  // Windows paths are checked on every platform (config files travel).
  const base = file.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "").trim();
  if (base.startsWith("deno")) return "deno";
  if (base.startsWith("bun")) return "bun";
  return "node";
}

export const RUNTIME_INSTALL_HINTS: Record<JsRuntimeName, string> = {
  deno: "curl -fsSL https://deno.land/install.sh | sh  (ويندوز: winget install DenoLand.Deno)",
  bun: "curl -fsSL https://bun.sh/install | bash",
  node: `ثبّت Node.js ${MIN_NODE_MAJOR}+ من nodejs.org أو استخدم nvm`,
};

type DetectOptions = {
  exists?: (file: string) => boolean;
  probe?: (file: string) => Promise<string | null>;
  env?: EnvLike;
  home?: string;
  platform?: NodeJS.Platform;
};

async function probeVersion(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, ["--version"], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const text = stdout.toString().trim();
      const match = text.match(/\d+\.\d+\.\d+/);
      resolve(match ? match[0] : text || null);
    });
  });
}

/** Find every JS runtime we can, whether usable or not (diagnostics want both). */
export async function detectJsRuntimes(options: DetectOptions = {}): Promise<JsRuntimeInfo[]> {
  const exists = options.exists ?? existsSync;
  const probe = options.probe ?? probeVersion;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;

  const found: JsRuntimeInfo[] = [];
  for (const name of JS_RUNTIME_PRIORITY) {
    const candidate = candidatePaths(name, env, home, platform).find((p) => exists(p));
    if (!candidate) continue;
    // Archive/snapshot restores drop the POSIX exec bit (seen on this machine for
    // ~/.deno/bin/deno → "Permission denied" instead of a version). Fix it for
    // runtimes inside the user's home, where these installers put them.
    if (candidate.startsWith(home)) ensureExecutable(candidate);
    const file = candidate;
    const version = await probe(file);
    found.push({
      name,
      path: file,
      version,
      supported: isRuntimeSupported(name, version),
      reason: rejectionReason(name, version),
    });
  }
  return found;
}

let cached: { at: number; list: JsRuntimeInfo[] } | null = null;
const CACHE_MS = 60_000;

/** Cached detection — called on every job start and by diagnostics. */
export async function getJsRuntimes(force = false): Promise<JsRuntimeInfo[]> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.list;
  const list = await detectJsRuntimes();
  cached = { at: Date.now(), list };
  return list;
}

export function clearRuntimeCache(): void {
  cached = null;
}

/** One-line, user-facing summary of runtime state (used by the UI + diagnostics). */
export function runtimeSummary(list: JsRuntimeInfo[]): { ok: boolean; message: string; hint: string | null } {
  const usable = pickJsRuntime(list);
  if (usable) {
    return { ok: true, message: `محرك JavaScript: ${usable.name} ${usable.version}`, hint: null };
  }
  const rejected = list.find((item) => item.reason);
  return {
    ok: false,
    message: rejected
      ? `محرك JavaScript غير صالح: ${rejected.name} ${rejected.version ?? ""} — ${rejected.reason}`
      : "لا يوجد محرك JavaScript (Deno/Bun/Node) — قد تنقص جودات يوتيوب أو تفشل بصيغة 403.",
    hint: `ثبّت Deno: ${RUNTIME_INSTALL_HINTS.deno}`,
  };
}
