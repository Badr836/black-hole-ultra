import { readFileSync, statSync } from "node:fs";
import { TOKEN_FILE } from "./access-token";

/**
 * Live token read for the access guard.
 *
 * `next.config.ts` writes the token into `process.env` at boot, but a rotation
 * performed later by `POST /api/access` is a *runtime* change: the value baked
 * into the guard's context does not move (verified: after rotating, the old
 * token still returned 200 and the new one 401). Re-reading the small file is
 * cheap and makes rotation take effect immediately.
 *
 * Used by Node routes only (`/api/access`, `/api/access/verify`); the edge
 * middleware must never import this file (the bundler rejects node:fs there).
 */
let cached: { token: string | null; mtimeMs: number } = { token: null, mtimeMs: 0 };

export function readLiveToken(file: string = TOKEN_FILE): string | null {
  try {
    const info = statSync(file);
    if (info.mtimeMs === cached.mtimeMs) return cached.token;
    const token = readFileSync(file, "utf8").trim() || null;
    cached = { token, mtimeMs: info.mtimeMs };
    return token;
  } catch {
    return null;
  }
}
