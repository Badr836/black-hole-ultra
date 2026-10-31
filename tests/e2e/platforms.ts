/**
 * Live platform checks: TikTok / X (Twitter) / Instagram.
 *
 * These need the public internet and are therefore a *separate* suite — the
 * offline integration suite must never depend on them:
 *
 *   npm start
 *   npm run test:e2e:platforms
 *
 * What it does, per platform: analyze through the app's own API, then download a
 * small file and verify it with ffprobe. Results are classified instead of
 * "pass/fail", because "Instagram asks for a login" is a fact about the network
 * and cookies, not a bug in the app:
 *
 *   ok             — media was found (and a file was produced when downloading)
 *   no-media       — the post exists but has no video/image the extractor knows
 *   auth-required  — the platform demands cookies/login
 *   rate-limited   — 429 from this IP (temporary)
 *   blocked        — network-level rejection
 *
 * Exit code is 0 unless PLATFORMS_STRICT=1 and a platform that should work fails.
 * A JSON report is written to docs/platforms-live.json for the record.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const STRICT = process.env.PLATFORMS_STRICT === "1";
const DOWNLOAD = process.env.PLATFORMS_DOWNLOAD !== "0";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const TIMEOUT_MS = Number(process.env.PLATFORMS_TIMEOUT_MS ?? 150_000);

type Verdict = "ok" | "no-media" | "auth-required" | "rate-limited" | "blocked" | "error";

type PlatformResult = {
  platform: string;
  url: string;
  verdict: Verdict;
  detail: string;
  title?: string | null;
  downloadStatus?: string | null;
  fileBytes?: number | null;
  probed?: string | null;
  elapsedMs: number;
};

const PLATFORMS: { platform: string; env: string; urls: string[] }[] = [
  {
    platform: "TikTok",
    env: "PLATFORM_TIKTOK_URL",
    urls: [
      "https://www.tiktok.com/@scout2015/video/6718335390845095173",
      "https://www.tiktok.com/@tiktok/video/7106594312292453675",
    ],
  },
  {
    platform: "X (Twitter)",
    env: "PLATFORM_X_URL",
    urls: [
      "https://x.com/SpaceX/status/1732824684683784516",
      "https://x.com/NASA/status/1636426299478233088",
    ],
  },
  {
    platform: "Instagram",
    env: "PLATFORM_INSTAGRAM_URL",
    urls: ["https://www.instagram.com/p/BT6E2wBFk6L/"],
  },
];

function classify(message: string): { verdict: Verdict; detail: string } {
  const text = message ?? "";
  if (/429|too many requests|rate.?limit|حد المعدل|كثير من الطلبات/i.test(text)) {
    return { verdict: "rate-limited", detail: "المنصة تردّ بـ429 من عنوان IP هذا (حدّ مؤقت)." };
  }
  if (/empty media response|cookies|login|تسجيل الدخول|يتطلب كوكيز|authentication|private|not authorized/i.test(text)) {
    return { verdict: "auth-required", detail: "المنصة تطلب كوكيز/تسجيل دخول لهذا المحتوى." };
  }
  if (/no video|no media|could be found|لا يوجد/i.test(text)) {
    return { verdict: "no-media", detail: "الرابط موجود لكن لا وسائط قابلة للتنزيل فيه." };
  }
  if (/getaddrinfo|enotfound|connection|timed out|ssl|network|شبكة/i.test(text)) {
    return { verdict: "blocked", detail: "تعذّر الوصول عبر الشبكة." };
  }
  return { verdict: "error", detail: text.slice(0, 300) };
}

async function json<T>(route: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${route}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function probeFile(file: string): string | null {
  try {
    return execFileSync(
      FFPROBE,
      ["-v", "error", "-show_entries", "format=duration,format_name", "-of", "csv=p=0", file],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return null;
  }
}

async function runPlatform(entry: (typeof PLATFORMS)[number]): Promise<PlatformResult> {
  const started = Date.now();
  const candidates = process.env[entry.env] ? [process.env[entry.env] as string] : entry.urls;

  let lastResult: PlatformResult | null = null;
  for (const url of candidates) {
    const analyze = await json<{ title?: string; videoOptions?: unknown[]; directOptions?: unknown[]; mediaKind?: string; error?: string }>(
      "/api/analyze",
      { method: "POST", body: JSON.stringify({ url, playlist: false }) },
    );
    if (analyze.status !== 200) {
      const classified = classify(analyze.body.error ?? `HTTP ${analyze.status}`);
      lastResult = { platform: entry.platform, url, ...classified, elapsedMs: Date.now() - started };
      // A blocked/rate-limited platform will not get better by trying the next URL.
      if (classified.verdict === "rate-limited" || classified.verdict === "blocked") return lastResult;
      continue;
    }

    const options = (analyze.body.videoOptions?.length ?? 0) + (analyze.body.directOptions?.length ?? 0);
    if (options === 0) {
      lastResult = {
        platform: entry.platform,
        url,
        verdict: "no-media",
        detail: "لم يُعِد التحليل أي صيغة قابلة للتنزيل.",
        title: analyze.body.title ?? null,
        elapsedMs: Date.now() - started,
      };
      continue;
    }

    const result: PlatformResult = {
      platform: entry.platform,
      url,
      verdict: "ok",
      detail: `${options} صيغة متاحة`,
      title: analyze.body.title ?? null,
      elapsedMs: Date.now() - started,
    };
    if (!DOWNLOAD) return result;

    const created = await json<{ id: number }>("/api/downloads", {
      method: "POST",
      body: JSON.stringify({
        url,
        title: analyze.body.title ?? `${entry.platform} live check`,
        kind: analyze.body.mediaKind === "image" ? "image" : "video",
        quality: "360",
        container: analyze.body.mediaKind === "image" ? "jpg" : "mp4",
        playlist: false,
      }),
    });
    if (created.status !== 201 || !created.body.id) {
      result.verdict = "error";
      result.detail = `تعذّر إضافة التحميل (HTTP ${created.status})`;
      return result;
    }

    let status = "queued";
    let filePath: string | null = null;
    let bytes: number | null = null;
    let error: string | null = null;
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const row = await json<{ status: string; filePath: string | null; totalBytes: number | null; error: string | null }>(
        `/api/downloads/${created.body.id}`,
      );
      status = row.body.status;
      filePath = row.body.filePath;
      bytes = row.body.totalBytes;
      error = row.body.error;
      if (["completed", "failed", "cancelled"].includes(status)) break;
      await sleep(1500);
    }
    result.downloadStatus = status;
    result.fileBytes = bytes;
    result.probed = filePath ? probeFile(filePath) : null;
    if (status !== "completed") {
      const classified = classify(error ?? `status=${status}`);
      result.verdict = classified.verdict === "error" ? "error" : classified.verdict;
      result.detail = error ?? classified.detail;
    }
    await fetch(`${BASE}/api/downloads/${created.body.id}?deleteFile=1`, { method: "DELETE" });
    return result;
  }

  return (
    lastResult ?? {
      platform: entry.platform,
      url: candidates[0] ?? "",
      verdict: "error",
      detail: "لا رابط للفحص",
      elapsedMs: Date.now() - started,
    }
  );
}

async function main() {
  const health = await json<{ ok: boolean }>("/api/health");
  if (health.status !== 200) {
    console.error(`لا يوجد خادم على ${BASE} — شغّل npm start أولاً.`);
    process.exit(1);
  }

  const results: PlatformResult[] = [];
  for (const entry of PLATFORMS) {
    process.stdout.write(`… ${entry.platform}: `);
    const result = await runPlatform(entry);
    results.push(result);
    console.log(`${result.verdict} — ${result.detail}`);
  }

  console.log("\n== ملخّص ==");
  for (const result of results) {
    console.log(
      `${result.platform.padEnd(12)} ${result.verdict.padEnd(14)} ${result.downloadStatus ?? "-"} ` +
        `${result.fileBytes ? `${Math.round(result.fileBytes / 1024)} KB` : ""} ${result.probed ? `[${result.probed}]` : ""}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    download: DOWNLOAD,
    note: "نتائج فعلية من هذا الجهاز/الشبكة — 429 أو طلب كوكيز سلوك منصة لا خطأ في التطبيق.",
    results,
  };
  try {
    mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });
    writeFileSync(path.join(process.cwd(), "docs", "platforms-live.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log("\nكُتب التقرير: docs/platforms-live.json");
  } catch (error) {
    console.log(`تعذّر كتابة التقرير: ${error instanceof Error ? error.message : String(error)}`);
  }

  const failures = results.filter((result) => result.verdict === "error");
  if (STRICT && failures.length > 0) {
    console.log(`\nPLATFORMS_STRICT=1 — ${failures.length} إخفاق حقيقي.`);
    process.exit(1);
  }
  console.log(`\n${results.filter((r) => r.verdict === "ok").length}/${results.length} منصات تعمل من هذه الشبكة.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("platforms crashed:", error);
  process.exit(1);
});
