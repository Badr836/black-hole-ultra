import { NextResponse } from "next/server";
import { tokenEquals } from "@/lib/access";
import { readLiveToken } from "@/lib/access-node";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Internal endpoint used by the edge middleware to validate a *rotated* token.
 * Excluded from the middleware matcher, so it never recurses.
 *
 * Hardening: a tiny in-memory attempt limiter, because this is the one place a
 * token can be guessed without the middleware's own fast path.
 */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 30;
const attempts = new Map<string, { count: number; resetAt: number }>();

function allowed(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_ATTEMPTS;
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!allowed(ip)) {
    return NextResponse.json({ ok: false, error: "محاولات كثيرة" }, { status: 429 });
  }

  let token = "";
  try {
    token = String(((await req.json()) as { token?: string }).token ?? "");
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const live = readLiveToken() ?? process.env.BLACKHOLE_TOKEN?.trim() ?? "";
  return NextResponse.json({ ok: tokenEquals(token, live) });
}
