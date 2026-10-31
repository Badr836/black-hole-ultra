import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Auto-generated LAN access token.
 *
 * Called from `next.config.ts` (Node, evaluated when the server boots) so the
 * generated value is present in `process.env` before any request is served.
 * Middleware only *reads* it, which is why that file lives in the edge-safe
 * `access.ts` module instead.
 */

export const TOKEN_FILE = path.join(process.cwd(), "data", "access-token.txt");

/** A bind address that is reachable from outside this machine. */
export function isPublicBind(hostname: string | undefined): boolean {
  const value = (hostname ?? "").trim().toLowerCase();
  if (!value) return true; // Next defaults to 0.0.0.0 when HOSTNAME is empty
  return value === "0.0.0.0" || value === "::" || value === "[::]" || value === "0";
}

export function generateToken(): string {
  return randomBytes(24).toString("hex");
}

export function readTokenFile(file: string | null | undefined = TOKEN_FILE): string | null {
  if (!file) return null;
  try {
    const value = readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function writeTokenFile(token: string, file: string | null | undefined = TOKEN_FILE): string | null {
  if (!file) return null;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    if (!existsSync(file)) return null;
    return file;
  } catch {
    return null;
  }
}

/**
 * Resolve the token to enforce. Order:
 *   1. `BLACKHOLE_TOKEN` (explicit, never overwritten);
 *   2. existing `data/access-token.txt`;
 *   3. a freshly generated one — but only for a public bind, and only when
 *      `BLACKHOLE_AUTO_TOKEN !== "0"`.
 *
 * Returns `{ token, source, file }` so the caller can print instructions.
 */
export function resolveAccessToken(
  env: Record<string, string | undefined> = process.env,
  file: string | null | undefined = TOKEN_FILE,
): { token: string | null; source: "env" | "file" | "generated" | "disabled" | "loopback"; file: string | null } {
  const explicit = env.BLACKHOLE_TOKEN?.trim();
  if (explicit) {
    if (!readTokenFile(file)) writeTokenFile(explicit, file);
    return { token: explicit, source: "env", file };
  }

  if (env.BLACKHOLE_AUTO_TOKEN === "0") {
    return { token: null, source: "disabled", file: null };
  }

  if (!isPublicBind(env.HOSTNAME ?? env.BLACKHOLE_BIND)) {
    return { token: null, source: "loopback", file: null };
  }

  const existing = readTokenFile(file);
  if (existing) return { token: existing, source: "file", file };

  const generated = generateToken();
  const written = writeTokenFile(generated, file);
  return { token: generated, source: "generated", file: written };
}
