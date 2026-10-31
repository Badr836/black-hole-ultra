import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFileSync } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const run = promisify(execFile);
const TTL_MS = 30 * 60 * 1000;
const globalCache = globalThis as typeof globalThis & {
  __bhUpstream?: { at: number; data: unknown };
};

/**
 * "Always learn from GitHub": reports the latest upstream releases of the
 * engines and reference apps, and whether the local binaries are behind.
 * Cached for 30 minutes so the UI can poll it safely.
 */
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const cached = globalCache.__bhUpstream;
  if (!force && cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json({ ...(cached.data as object), cached: true });
  }

  const cacheFile = path.join(process.cwd(), "data", "upstream-cache.json");
  const readDisk = (): (Record<string, unknown> & { checkedAt?: string }) | null => {
    try {
      return JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, unknown> & { checkedAt?: string };
    } catch {
      return null;
    }
  };

  const onDisk = readDisk();
  const diskFresh =
    onDisk?.checkedAt !== undefined && Date.now() - Date.parse(String(onDisk.checkedAt)) < TTL_MS;

  const script = path.join(process.cwd(), "scripts", "upstream-check.mjs");
  try {
    const { stdout } = await run(process.execPath, [script, "--json"], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const data = JSON.parse(stdout) as Record<string, unknown>;
    globalCache.__bhUpstream = { at: Date.now(), data };
    return NextResponse.json({ ...data, cached: false });
  } catch (error) {
    const fallback = onDisk ?? null;
    if (fallback) {
      return NextResponse.json({ ...fallback, cached: true, stale: true, warning: "تعذّر تحديث القائمة الآن؛ تُعرض آخر نتيجة محفوظة." });
    }
    void diskFresh;
    return NextResponse.json(
      {
        error: "تعذّر الاستعلام من GitHub الآن.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
