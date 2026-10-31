/**
 * Strict HTTP Range parser.
 *
 * The previous implementation used a loose regex and `Number(...)` which turned
 * `bytes=abc-def` into `NaN` and passed it to `createReadStream` (→ 500), and it
 * never checked `start <= end`. Callers now get an explicit verdict.
 */

export type RangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "invalid"; reason: string };

export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header || !header.trim()) return { kind: "full" };
  if (!Number.isFinite(size) || size <= 0) return { kind: "invalid", reason: "حجم الملف غير معروف" };

  const value = header.trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match) return { kind: "invalid", reason: "ترويسة Range غير مدعومة" };

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "invalid", reason: "مدى فارغ" };

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "invalid", reason: "لاحقة غير صالحة" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { kind: "invalid", reason: "قيم غير رقمية" };
    }
    if (start < 0) return { kind: "invalid", reason: "بداية سالبة" };
    if (start >= size) return { kind: "invalid", reason: "البداية تتجاوز حجم الملف" };
    if (end < start) return { kind: "invalid", reason: "نهاية قبل البداية" };
    if (end > size - 1) end = size - 1;
  }

  return { kind: "partial", start, end };
}

export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

export const UNSATISFIABLE_RANGE_HEADERS = (size: number): Record<string, string> => ({
  "Content-Range": `bytes */${size}`,
  "Accept-Ranges": "bytes",
});
