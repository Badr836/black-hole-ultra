/**
 * Direct HTTP(S) file source — resumable, verified, bounded.
 *
 * Why this exists: yt-dlp handles plain file URLs, but it hides the facts we
 * need to be honest about recovery — which byte we stopped at, whether the
 * server supports `Range`, whether the `ETag`/`Last-Modified` still matches the
 * bytes already on disk. For direct media URLs we stream ourselves so the job
 * row can persist the offset and the validator and truly resume.
 *
 * Deliberate limits (never claimed otherwise):
 *  - Resume needs an HTTP server that answers `Range` (206). Without it we
 *    restart from zero and say so.
 *  - Validation is only as strong as the server: `ETag`/`Last-Modified` when
 *    present, otherwise size-only.
 *  - No proxy, no authentication bypass, no DRM handling.
 */

import { createWriteStream, existsSync, renameSync, statSync, truncateSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const DIRECT_MEDIA_EXT = new Set([
  "mp4", "m4v", "mkv", "webm", "mov", "avi", "flv", "ts", "m4a", "mp3", "aac",
  "ogg", "oga", "opus", "flac", "wav", "wma", "jpg", "jpeg", "png", "webp",
  "gif", "avif", "pdf", "zip", "7z", "rar",
]);

export type DirectProbe = {
  url: string;
  size: number | null;
  acceptRanges: boolean;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  fileName: string | null;
};

function extOf(urlOrPath: string): string {
  const clean = urlOrPath.split(/[?#]/)[0] ?? "";
  const base = clean.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Cheap, offline guess: does this URL *look* like a single file? */
export function isDirectFileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const ext = extOf(u.pathname);
    if (!DIRECT_MEDIA_EXT.has(ext)) return false;
    // A page URL that merely ends in .mp4 inside a query string is not a file.
    return /\.([a-z0-9]+)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  if (!value) return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === "*" ? null : Number(m[3]),
  };
}

function fileNameFromHeaders(res: Response, url: string): string | null {
  const cd = res.headers.get("content-disposition");
  if (cd) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
      } catch {
        /* fall through */
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    if (plain) return plain[1].trim();
  }
  try {
    const base = new URL(url).pathname.split("/").pop();
    if (base) return decodeURIComponent(base);
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Probe a URL without downloading it: size, validator, and — crucially — whether
 * the server actually honours `Range`. Returns `null` when the URL is not a plain
 * downloadable file (caller then falls back to the extractor).
 */
export async function probeDirect(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DirectProbe | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);

  const attempt = async (method: "HEAD" | "GET"): Promise<Response | null> => {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        headers: method === "GET" ? { ...headers, Range: "bytes=0-0" } : headers,
        signal,
      });
      return res;
    } catch {
      return null;
    }
  };

  let res = await attempt("HEAD");
  // Some CDNs answer HEAD with 405/403 while GET works fine.
  if (!res || res.status >= 400) {
    try {
      await res?.body?.cancel();
    } catch {
      /* ignore */
    }
    res = await attempt("GET");
  }
  if (!res) return null;

  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }

  if (res.status >= 400 && res.status !== 206) {
    // 403/404/410 still tell us the URL is *a file URL*; the engine decides.
    if (!isDirectFileUrl(url)) return null;
    return {
      url: res.url || url,
      size: null,
      acceptRanges: false,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      contentType: res.headers.get("content-type"),
      fileName: fileNameFromHeaders(res, url),
    };
  }

  const contentType = res.headers.get("content-type");
  const contentRange = parseContentRange(res.headers.get("content-range"));
  const looksMedia =
    Boolean(contentType && /^(video|audio|image)\//i.test(contentType)) ||
    (contentType ?? "").toLowerCase().startsWith("application/octet-stream") ||
    (contentType ?? "").toLowerCase().startsWith("application/pdf") ||
    (contentType ?? "").toLowerCase().startsWith("application/zip");

  if (!isDirectFileUrl(url) && !looksMedia) return null;

  const acceptRanges =
    (res.headers.get("accept-ranges") ?? "").toLowerCase().includes("bytes") || Boolean(contentRange);

  let size: number | null = null;
  if (contentRange?.total != null) size = contentRange.total;
  else {
    const len = res.headers.get("content-length");
    if (len && Number.isFinite(Number(len))) {
      const n = Number(len);
      // With a 206 probe, Content-Length is the *chunk* length, not the file.
      size = res.status === 206 ? null : n;
    }
  }

  return {
    url: res.url || url,
    size,
    acceptRanges,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    contentType,
    fileName: fileNameFromHeaders(res, url),
  };
}

export type DirectProgress = { bytes: number; total: number | null; speedBps: number };

export type DirectDownloadOptions = {
  url: string;
  destPath: string;
  partPath?: string;
  headers?: Record<string, string>;
  /** Validator stored on the previous attempt; used to prove the bytes still match. */
  expectedEtag?: string | null;
  expectedLastModified?: string | null;
  expectedSize?: number | null;
  /** Total attempts (first try included). */
  maxAttempts?: number;
  /** Per-request socket timeout. */
  timeoutMs?: number;
  onProgress?: (p: DirectProgress) => void;
  onResume?: (info: { offset: number; total: number | null; validator: "etag" | "last-modified" | "none" }) => void;
  /** Re-extract a fresh URL when the current one is expired (403/410). */
  refreshUrl?: () => Promise<string | null>;
  signal?: AbortSignal;
  /** Clock injection keeps retry tests fast and deterministic. */
  sleep?: (ms: number) => Promise<void>;
};

export type DirectDownloadResult =
  | {
      ok: true;
      path: string;
      bytes: number;
      resumedFrom: number;
      restarted: boolean;
      etag: string | null;
      lastModified: string | null;
      verified: boolean;
    }
  | {
      ok: false;
      reason: "aborted" | "http" | "network" | "size" | "unsupported";
      message: string;
      bytes: number;
    };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, 8s … capped at 30s. Deterministic (no jitter) so tests can assert.
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Download `url` into `destPath`, resuming from the `.part` file when the server
 * supports it and the validators still match. The final file only appears after
 * the byte count is verified.
 */
export async function downloadDirect(opts: DirectDownloadOptions): Promise<DirectDownloadResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const partPath = opts.partPath ?? `${opts.destPath}.part`;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  await mkdir(path.dirname(partPath), { recursive: true });

  let currentUrl = opts.url;
  let refreshed = false;
  let restarted = false;
  let lastError = "";
  /** Last total the server told us about — used to decide integrity at the end. */
  let knownTotal: number | null = opts.expectedSize ?? null;
  let attempt = 0;

  // Resume decision is made once, from what is actually on disk.
  let offset = sizeOf(partPath);
  if (offset === 0 && existsSync(partPath)) truncateSync(partPath, 0);

  while (attempt < maxAttempts) {
    attempt += 1;
    if (opts.signal?.aborted) {
      return { ok: false, reason: "aborted", message: "أُلغيت المهمة", bytes: offset };
    }

    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`;
      const validator = opts.expectedEtag || opts.expectedLastModified;
      if (validator) headers["If-Range"] = validator;
    }

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        headers,
        redirect: "follow",
        signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (opts.signal?.aborted) return { ok: false, reason: "aborted", message: lastError, bytes: offset };
      await sleep(backoffMs(attempt));
      continue;
    }

    // Expired / dead signed URL: ask the caller for a fresh one, once.
    if ((res.status === 403 || res.status === 410) && opts.refreshUrl && !refreshed) {
      refreshed = true;
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      const fresh = await opts.refreshUrl();
      if (fresh && fresh !== currentUrl) {
        currentUrl = fresh;
        attempt -= 1; // a refresh is not a failed attempt
        continue;
      }
      return { ok: false, reason: "http", message: `HTTP ${res.status} — تعذّر تجديد الرابط`, bytes: offset };
    }

    if (res.status === 416) {
      // Range not satisfiable: either we already have everything, or start over.
      const total = opts.expectedSize ?? null;
      if (total != null && offset >= total) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        return finish({ partPath, destPath: opts.destPath, offset, total, etag: null, lastModified: null });
      }
      offset = 0;
      restarted = true;
      truncateSync(partPath, 0);
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      continue;
    }

    if (res.status !== 200 && res.status !== 206) {
      lastError = `HTTP ${res.status}`;
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      // 5xx and 408 are worth another attempt; 4xx are not.
      if (res.status >= 500 || res.status === 408 || res.status === 429) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return { ok: false, reason: "http", message: lastError, bytes: offset };
    }

    // Range requested but server answered 200 → it ignored the offset: restart.
    if (offset > 0 && res.status === 200) {
      offset = 0;
      restarted = true;
      truncateSync(partPath, 0);
    }

    // Even a 206 can be wrong: if the server returns a 206 whose ETag differs from
    // the one the stored bytes came from, those bytes belong to another version.
    // Do not trust If-Range alone — verify and start over.
    if (
      res.status === 206 &&
      offset > 0 &&
      opts.expectedEtag &&
      res.headers.get("etag") &&
      res.headers.get("etag") !== opts.expectedEtag
    ) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      offset = 0;
      restarted = true;
      truncateSync(partPath, 0);
      continue;
    }

    const contentRange = parseContentRange(res.headers.get("content-range"));
    const total: number | null = contentRange?.total ?? (() => {
      const len = res.headers.get("content-length");
      const n = len ? Number(len) : NaN;
      return Number.isFinite(n) ? n + (res.status === 206 ? offset : 0) : opts.expectedSize ?? null;
    })();

    if (total != null) knownTotal = total;
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");

    opts.onResume?.({
      offset,
      total,
      validator: opts.expectedEtag ? "etag" : opts.expectedLastModified ? "last-modified" : "none",
    });

    const startedAt = Date.now();
    const startedBytes = offset;
    let written = offset;
    let lastReport = 0;

    try {
      const out = createWriteStream(partPath, { flags: offset > 0 ? "a" : "w" });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("لا يوجد جسم استجابة");

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        await new Promise<void>((resolve, reject) => {
          out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
        });
        written += value.byteLength;
        const now = Date.now();
        if (now - lastReport >= 500) {
          lastReport = now;
          const elapsed = Math.max(1, now - startedAt) / 1000;
          opts.onProgress?.({
            bytes: written,
            total,
            speedBps: Math.max(0, (written - startedBytes) / elapsed),
          });
        }
        if (opts.signal?.aborted) {
          await new Promise<void>((resolve) => out.end(() => resolve()));
          return { ok: false, reason: "aborted", message: "أُلغيت المهمة", bytes: written };
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      opts.onProgress?.({ bytes: written, total, speedBps: 0 });

      const verified = total == null ? false : written === total;
      if (total != null && written !== total) {
        lastError = `الحجم بعد النقل ${written} بايت والمتوقع ${total}`;
        offset = written;
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        return { ok: false, reason: "size", message: lastError, bytes: written };
      }

      const result = finish({
        partPath,
        destPath: opts.destPath,
        offset: written,
        total,
        etag,
        lastModified,
      });
      if (!result.ok) return result;
      return { ...result, resumedFrom: startedBytes, restarted, verified };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      offset = sizeOf(partPath);
      if (opts.signal?.aborted) return { ok: false, reason: "aborted", message: lastError, bytes: offset };
      if (attempt >= maxAttempts) break;
      await sleep(backoffMs(attempt));
      continue;
    }
  }

  // Distinguish "the link was flaky" from "the bytes we got are short of the
  // announced size": the second one is an integrity failure the user can fix by
  // retrying (we resume), while hiding it would be a lie about a partial file.
  const finalBytes = sizeOf(partPath);
  const expected = knownTotal ?? opts.expectedSize ?? null;
  if (expected != null && finalBytes < expected) {
    return {
      ok: false,
      reason: "size",
      message: `الحجم بعد النقل ${finalBytes} بايت والمتوقع ${expected}${lastError ? ` (${lastError})` : ""}`,
      bytes: finalBytes,
    };
  }
  return { ok: false, reason: "network", message: lastError || "فشلت كل المحاولات", bytes: finalBytes };
}

function finish(args: {
  partPath: string;
  destPath: string;
  offset: number;
  total: number | null;
  etag: string | null;
  lastModified: string | null;
}):
  | { ok: true; path: string; bytes: number; resumedFrom: number; restarted: boolean; etag: string | null; lastModified: string | null; verified: boolean }
  | { ok: false; reason: "size"; message: string; bytes: number } {
  const { partPath, destPath, offset, total } = args;
  const onDisk = sizeOf(partPath);
  if (total != null && onDisk !== total) {
    return {
      ok: false,
      reason: "size",
      message: `الملف الجزئي ${onDisk} بايت والمتوقع ${total}`,
      bytes: onDisk,
    };
  }
  if (onDisk === 0) {
    return { ok: false, reason: "size", message: "الملف الجزئي فارغ", bytes: 0 };
  }
  // Atomic publish: the final name only exists once the bytes are verified.
  renameSync(partPath, destPath);
  return {
    ok: true,
    path: destPath,
    bytes: onDisk,
    resumedFrom: offset,
    restarted: false,
    etag: args.etag,
    lastModified: args.lastModified,
    verified: total != null,
  };
}
