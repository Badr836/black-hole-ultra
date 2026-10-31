import type { Download, Settings } from "@/db/schema";
import type { AnalyzeResult } from "@/lib/analyzer";

export type DownloadItem = Download & { fileAvailable: boolean; running: boolean };
export type { AnalyzeResult, Settings };

/** Aggregate library numbers returned alongside the queue. */
export type LibraryStats = {
  count: number;
  bytes: number;
  freeSpace: number | null;
  outputDir: string;
};

export type SystemInfo = {
  platform: string;
  ytdlp: { path: string | null; version: string | null; ok: boolean };
  ffmpeg: { path: string | null; version: string | null; ok: boolean };
  ffprobe: { path: string | null; version: string | null; ok: boolean };
  gallerydl?: { path: string | null; version: string | null; ok: boolean };
  nm3u8dl?: { path: string | null; version: string | null; ok: boolean };
  mediaToolsOk: boolean;
  outputDir: string;
  providerPreference?: "auto" | "ytdlp" | "gallerydl" | "nm3u8dl";
  allowInsecureTls?: boolean;
  database?: { engine: string; schemaVersion: number };
  active?: number;
};

/** Answer of /api/access — where the token comes from and how to reach the LAN. */
export type AccessInfo = {
  ok: boolean;
  publicBind: boolean;
  bind: string;
  source: "env" | "file" | "none";
  hasToken: boolean;
  autoTokenDisabled: boolean;
  allowUnauthenticated: boolean;
  token: string | null;
  tokenFile: string;
  tokenLength: number;
  urls: string[];
  port: string;
  rotated?: boolean;
  persisted?: boolean;
  note?: string;
};

/** Answer of POST /api/hls/inspect (master-playlist introspection). */
export type HlsInspect = {
  ok?: boolean;
  url?: string;
  isMaster?: boolean;
  drm?: boolean;
  segmentCount?: number;
  variants?: {
    url: string;
    width: number | null;
    height: number | null;
    bandwidth: number | null;
    codecs: string | null;
    range: string | null;
    frameRate: number | null;
  }[];
  audio?: {
    groupId: string | null;
    name: string | null;
    language: string | null;
    isDefault: boolean;
    channels: string | null;
    uri: string | null;
  }[];
  headersUsed?: string | null;
  headersNote?: string | null;
  probeNote?: string;
  suggestions?: {
    heights: (number | null)[];
    ranges: (string | null)[];
    codecs: (string | null)[];
    audioLanguages: (string | null)[];
  };
};

export function fmtBytes(n?: number | null): string {
  if (!n || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtDuration(sec?: number | null): string {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "في الطابور",
  downloading: "جارٍ التحميل",
  converting: "معالجة / دمج",
  paused: "متوقف مؤقتاً",
  completed: "مكتمل",
  failed: "فشل",
  cancelled: "ملغى",
  missing: "الملف مفقود",
};

export const STATUS_COLOR: Record<string, string> = {
  queued: "text-violet-300 bg-violet-950/60 border-violet-800",
  downloading: "text-fuchsia-200 bg-fuchsia-950/60 border-fuchsia-800",
  converting: "text-amber-200 bg-amber-950/60 border-amber-800",
  paused: "text-slate-300 bg-slate-900/60 border-slate-700",
  completed: "text-emerald-200 bg-emerald-950/60 border-emerald-800",
  failed: "text-rose-200 bg-rose-950/60 border-rose-800",
  cancelled: "text-slate-400 bg-slate-900/60 border-slate-700",
  missing: "text-orange-200 bg-orange-950/60 border-orange-800",
};

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  // GET requests and URL analysis are idempotent, so retrying cannot create
  // duplicate download jobs. This handles temporary preview/proxy wake-ups.
  const canRetry = method === "GET" || url === "/api/analyze" || url === "/api/system";
  const attempts = canRetry ? 3 : 1;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (res.ok) return data;
      if (![502, 503, 504].includes(res.status) || !canRetry) {
        throw new Error(data.error ?? `تعذّر تنفيذ الطلب (HTTP ${res.status})`);
      }
      lastError = new Error(data.error ?? `بوابة المعاينة غير متاحة مؤقتاً (${res.status})`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("تعذّر الاتصال بالخادم");
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
  }

  const message = lastError?.message ?? "";
  throw new Error(
    /HTTP|fetch|network|gateway|بوابة|502|503|504/i.test(message)
      ? "خادم المعاينة غير متاح مؤقتاً. انتظر لحظات ثم أعد المحاولة."
      : message || "تعذّر الاتصال بالخادم. أعد المحاولة بعد لحظات.",
  );
}
