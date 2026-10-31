/**
 * End-to-end smoke test against a running server.
 *
 *   npm run build && npm start          # terminal 1
 *   npm run test:e2e                    # terminal 2
 *
 * Skips itself (exit 0 with a notice) when yt-dlp is missing or the network is
 * unavailable, so it is safe in offline CI. Hard limit: 180s.
 */
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
/**
 * Candidate URLs, tried in order. YouTube bot-checks depend on the IP, so a
 * fixed URL makes the suite fail for environmental reasons (seen here: some
 * videos need cookies while others download fine). `E2E_URL`/`E2E_URLS` still
 * override the list.
 */
const TEST_URLS = (process.env.E2E_URLS ?? process.env.E2E_URL ?? [
  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=9bZkp7q19f0",
].join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
let TEST_URL = TEST_URLS[0] ?? "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const DEADLINE_MS = 180_000;
const startedAt = Date.now();

type Check = { name: string; ok: boolean; detail?: string };

type RowShape = {
  status: string;
  filePath: string | null;
  files: string[] | null;
  completedEntries: number | null;
  error: string | null;
  totalBytes: number | null;
};
const checks: Check[] = [];

function record(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const health = await json<{ ok: boolean; db: { schemaVersion: number } }>("/api/health");
  record("GET /api/health", health.status === 200 && health.body.ok === true, `schema v${health.body.db?.schemaVersion}`);

  const system = await json<{ ytdlp: { ok: boolean; version: string | null }; mediaToolsOk: boolean }>("/api/system");
  record("GET /api/system", system.status === 200 && system.body.ytdlp.ok, `yt-dlp ${system.body.ytdlp.version}`);

  if (!system.body.ytdlp.ok) {
    console.log("\n[skip] yt-dlp غير متاح — تخطّي اختبار التحميل الحقيقي.");
    return finish(0);
  }

  const diagnostics = await json<{ ok: boolean; checks: { outputWritable: boolean; impersonation: { supported: boolean } }; warnings: string[] }>("/api/diagnostics");
  record("GET /api/diagnostics", diagnostics.status === 200 && diagnostics.body.checks.outputWritable);
  for (const warning of diagnostics.body.warnings ?? []) console.log(`  ⚠ ${warning}`);

  const settings = await json<{ outputDir: string; allowInsecureTls: boolean }>("/api/settings");
  record("GET /api/settings", settings.status === 200 && Boolean(settings.body.outputDir));
  record("TLS verification is on by default", settings.body.allowInsecureTls === false);

  // --- validation guards ---------------------------------------------------
  const badUrl = await json<{ error?: string }>("/api/downloads", {
    method: "POST",
    body: JSON.stringify({ url: "not-a-url", kind: "video", container: "mp4", quality: "best" }),
  });
  record("reject invalid URL (400)", badUrl.status === 400, badUrl.body.error);

  const badPlaylist = await json<{ error?: string }>("/api/downloads", {
    method: "POST",
    body: JSON.stringify({
      url: "https://example.com/v",
      kind: "video",
      container: "mp4",
      quality: "best",
      playlist: true,
      playlistItems: "1-5, --exec rm",
    }),
  });
  record("reject malicious playlist-items (400)", badPlaylist.status === 400, badPlaylist.body.error);

  const escape = await json<{ error?: string }>("/api/downloads", {
    method: "POST",
    body: JSON.stringify({
      url: "https://example.com/v",
      kind: "video",
      container: "mp4",
      quality: "best",
      outputDir: "/etc",
    }),
  });
  record("reject outputDir outside allowed roots (400)", escape.status === 400, escape.body.error);

  // --- analysis ------------------------------------------------------------
  type AnalyzeShape = { title?: string; videoOptions?: { formatId: string; height: number }[] };
  let analysis: AnalyzeShape | null = null;
  const analyzeErrors: string[] = [];
  for (const candidate of TEST_URLS) {
    try {
      const analyze = await json<AnalyzeShape>("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ url: candidate, playlist: false }),
      });
      const optionCount = analyze.body?.videoOptions?.length ?? 0;
      if (analyze.status === 200 && optionCount > 0) {
        TEST_URL = candidate;
        analysis = analyze.body;
        record(
          "POST /api/analyze",
          true,
          `${optionCount} qualities · ${analyze.body?.title ?? ""}${candidate !== TEST_URLS[0] ? ` (بعد ${analyzeErrors.length} رابط محجوب)` : ""}`,
        );
        break;
      }
      analyzeErrors.push(`${candidate}: HTTP ${analyze.status}`);
    } catch (error) {
      analyzeErrors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!analysis) {
    record("POST /api/analyze", false, analyzeErrors.join(" | ").slice(0, 400));
  }

  if (!analysis) {
    console.log("\n[skip] تعذّر التحليل (شبكة؟) — تخطّي التحميل.");
    return finish(1);
  }

  // Plain media URLs used to yield zero options; the direct-file fallback must
  // make them downloadable (regression cover for the "no qualities" bug).
  try {
    const direct = await json<{ directOptions?: { formatId: string }[]; videoOptions?: unknown[] }>("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ url: "https://download.samplelib.com/mp4/sample-5s.mp4" }),
    });
    record(
      "direct media URL exposes a downloadable option",
      (direct.body.directOptions?.length ?? 0) > 0 || (direct.body.videoOptions?.length ?? 0) > 0,
      `${direct.body.directOptions?.length ?? 0} direct option(s)`,
    );
  } catch (error) {
    record("direct media URL exposes a downloadable option", false, error instanceof Error ? error.message : String(error));
  }

  // --- real download -------------------------------------------------------
  const created = await json<{ id: number }>("/api/downloads", {
    method: "POST",
    body: JSON.stringify({
      url: TEST_URL,
      title: analysis.title ?? "e2e",
      kind: "video",
      quality: "360",
      container: "mp4",
      subtitles: false,
      playlist: false,
    }),
  });
  record("POST /api/downloads (queue job)", created.status === 201 && typeof created.body.id === "number");

  const id = created.body.id;
  let status = "queued";
  let row: RowShape | null = null;

  while (Date.now() - startedAt < DEADLINE_MS) {
    const detail = await json<RowShape>(`/api/downloads/${id}`);
    row = detail.body;
    status = detail.body.status;
    if (["completed", "failed", "cancelled"].includes(status)) break;
    await sleep(1500);
  }

  record("download reached a terminal state", ["completed", "failed"].includes(status), `status=${status}`);
  record("download completed", status === "completed", row?.error ?? undefined);
  record("file size > 0", Boolean(row?.totalBytes && row.totalBytes > 0), `${row?.totalBytes ?? 0} bytes`);
  record("bookkeeping recorded the produced file(s)", Boolean(row?.files?.length), `${row?.files?.length ?? 0} file(s)`);

  if (status === "completed" && row?.filePath) {
    // Stream check: valid range → 206, malformed range → 416.
    const partial = await fetch(`${BASE}/api/downloads/${id}/file`, { headers: { Range: "bytes=0-1023" } });
    const buffer = Buffer.from(await partial.arrayBuffer());
    record("Range request returns 206 with 1024 bytes", partial.status === 206 && buffer.length === 1024, `${partial.status} / ${buffer.length}B`);

    const broken = await fetch(`${BASE}/api/downloads/${id}/file`, { headers: { Range: "bytes=abc-def" } });
    record("malformed Range returns 416 (not 500)", broken.status === 416, String(broken.status));

    // ffprobe the produced file to prove it is real media.
    try {
      const probe = execFileSync(
        process.env.FFPROBE_PATH ?? "ffprobe",
        ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", row.filePath],
        { encoding: "utf8" },
      );
      const streams = (JSON.parse(probe).streams ?? []) as { codec_type: string }[];
      record(
        "ffprobe validates the downloaded media",
        streams.some((s) => s.codec_type === "video"),
        streams.map((s) => s.codec_type).join("+"),
      );
    } catch (error) {
      record("ffprobe validates the downloaded media", false, error instanceof Error ? error.message : String(error));
    }
  }

  // Clean up the job so repeated runs stay fast.
  await fetch(`${BASE}/api/downloads/${id}?deleteFile=1`, { method: "DELETE" });
  const after = await json<{ items: { id: number }[] }>("/api/downloads");
  record("delete with deleteFile removes the record", !after.body.items?.some((item) => item.id === id));

  return finish(checks.some((c) => !c.ok) ? 1 : 0);
}

function finish(code: number) {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} فحوص ناجحة · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (failed.length > 0) {
    console.log("فشل:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  }
  process.exit(code);
}

main().catch((error) => {
  console.error("E2E crashed:", error);
  process.exit(1);
});
