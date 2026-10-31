/**
 * Playlist integrity + "retry the missing entries" support.
 *
 * Honest limitation that shaped this module: with `--print` (quiet mode) yt-dlp
 * hides per-entry lines, and for an entry that fails *extraction* it never emits
 * any marker at all. So we cannot rely on the engine telling us which index
 * broke — we reconcile three sources instead:
 *
 *   1. what the user asked for (`--playlist-items` spec, or "of N" from the log)
 *   2. markers for entries that at least reached the download stage (`BHITEM`)
 *   3. files that actually landed on disk (`BHFILE`)
 *
 * Anything in (1) that is absent from (3) is reported as missing, with the
 * matching ERROR line as the reason when one exists.
 */

export type PlaylistItem = { index: number; id: string };

export type MissingEntry = {
  /** 1-based playlist index, as used by `--playlist-items`. */
  index: number;
  /** Empty when the entry failed before the engine could name it. */
  id: string;
  reason: string;
};

/** `BHITEM:7|dQw4w9WgXcQ` → { index: 7, id: "dQw4w9WgXcQ" } */
export function parsePlaylistItemMarker(text: string): PlaylistItem | null {
  const match = (text ?? "").match(/^BHITEM:(\d{1,6})\|([A-Za-z0-9_-]{1,64})?\s*$/);
  if (!match) return null;
  return { index: Number(match[1]), id: match[2] ?? "" };
}

/** `BHFILE:dQw4w9WgXcQ|/videos/a.mp4` → { id, path } (id may be empty) */
export function parseFileMarker(text: string): { id: string; path: string } | null {
  const match = (text ?? "").match(/^BHFILE:([A-Za-z0-9_-]{0,64})\|(.+)$/);
  if (!match) return null;
  const path = match[2].trim();
  if (!path) return null;
  return { id: match[1] ?? "", path };
}

/** "1-5,8,12-14" → [1,2,3,4,5,8,12,13,14] */
export function playlistSpecToIndices(spec: string | null | undefined): number[] {
  if (!spec?.trim()) return [];
  const out = new Set<number>();
  for (const chunk of spec.split(",").map((part) => part.trim()).filter(Boolean)) {
    const range = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from) for (let i = from; i <= to && i - from < 5000; i += 1) out.add(i);
      continue;
    }
    if (/^\d+$/.test(chunk)) out.add(Number(chunk));
  }
  return [...out].sort((a, b) => a - b);
}

/** [3,4,5,9] → "3-5,9" (compact, so a retry never re-downloads finished items). */
export function indicesToSpec(indices: number[]): string {
  const sorted = [...new Set(indices)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const value of sorted) {
    if (start === null) {
      start = value;
      prev = value;
      continue;
    }
    if (prev !== null && value === prev + 1) {
      prev = value;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = value;
    prev = value;
  }
  if (start !== null) parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(",");
}

/** Highest "of N" the engine announced (yt-dlp prints it with --no-quiet). */
export function playlistTotalFromOutput(log: string): number | null {
  let max = 0;
  for (const match of (log ?? "").matchAll(/Downloading item \d+ of (\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max || null;
}

function errorLineFor(log: string, needle: string): string | null {
  if (!needle) return null;
  for (const line of (log ?? "").split(/\r?\n/)) {
    if (!/ERROR|WARNING/.test(line)) continue;
    if (!line.includes(needle)) continue;
    return line.replace(/^WARNING:\s*|^ERROR:\s*/, "").trim().slice(0, 300);
  }
  return null;
}

export function computeMissingEntries(args: {
  /** `--playlist-items` spec stored on the job, if any. */
  requested: string | null;
  /** "of N" from the engine output. */
  total: number | null;
  /** BHITEM markers seen during the run. */
  items: PlaylistItem[];
  /** Ids that actually produced a file (BHFILE). */
  producedIds: string[];
  log: string;
}): MissingEntry[] {
  const requested = playlistSpecToIndices(args.requested);
  let expected = requested;
  if (expected.length === 0) {
    const total = args.total ?? (args.items.length > 0 ? Math.max(...args.items.map((i) => i.index)) : null);
    if (total && total > 0) expected = Array.from({ length: Math.min(total, 5000) }, (_, i) => i + 1);
  }
  if (expected.length === 0) return [];

  const produced = new Set(args.producedIds.filter(Boolean));
  const idByIndex = new Map<number, string>();
  for (const item of args.items) if (item.id) idByIndex.set(item.index, item.id);

  const missing: MissingEntry[] = [];
  for (const index of expected) {
    const id = idByIndex.get(index) ?? "";
    if (id && produced.has(id)) continue;
    const reason = errorLineFor(args.log, id) ?? "لم يُنزَّل هذا العنصر (لم يصل إلى مرحلة الحفظ)";
    missing.push({ index, id, reason });
  }
  return missing;
}

/** Never re-download the whole playlist: only the indices that are missing. */
export function retrySpecFor(missing: MissingEntry[]): string {
  return indicesToSpec(missing.map((entry) => entry.index));
}

export function incompleteSummary(missing: MissingEntry[], expected: number): string {
  const produced = Math.max(0, expected - missing.length);
  const preview = missing
    .slice(0, 3)
    .map((entry) => `#${entry.index}${entry.id ? ` (${entry.id})` : ""}`)
    .join("، ");
  const more = missing.length > 3 ? ` و${missing.length - 3} أخرى` : "";
  return `قائمة ناقصة: حُفظ ${produced} من ${expected}. العناصر الناقصة: ${preview}${more}. استخدم «إعادة الناقص» لتحميلها وحدها.`;
}

/** Guard against an endless retry loop on a permanently broken entry. */
export const MAX_INCOMPLETE_RETRIES = 2;

export function canRetryIncomplete(metadata: Record<string, unknown> | null): { ok: boolean; reason: string | null } {
  const meta = metadata ?? {};
  const missing = Array.isArray(meta.missingItems) ? (meta.missingItems as MissingEntry[]) : [];
  if (missing.length === 0) return { ok: false, reason: "لا توجد عناصر ناقصة مسجّلة لهذا العنصر." };
  const attempts = typeof meta.incompleteRetry === "number" ? meta.incompleteRetry : 0;
  if (attempts >= MAX_INCOMPLETE_RETRIES) {
    return {
      ok: false,
      reason: `أُعيدت محاولة العناصر الناقصة ${attempts} مرات ولم تنجح. غالباً العنصر محذوف أو خاص — لا فائدة من تكرار المحاولة.`,
    };
  }
  return { ok: true, reason: null };
}
