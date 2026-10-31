import { NextResponse } from "next/server";
import {
  cookieCoverage,
  cookiesHint,
  defaultCookiePath,
  readCookieFile,
  saveCookieFile,
} from "@/lib/cookies";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reports which platforms the user's cookie session actually covers. */
export async function GET() {
  const s = await getSettings();
  const path = s.cookiesPath?.trim() || defaultCookiePath();
  const content = readCookieFile(path);
  const coverage = cookieCoverage(content);
  return NextResponse.json({
    path,
    exists: content !== null,
    ...coverage,
    hint: cookiesHint(),
  });
}

/** Accepts a Netscape cookies.txt body: { content: "..." }. */
export async function POST(req: Request) {
  let body: { content?: string; path?: string };
  try {
    body = (await req.json()) as { content?: string; path?: string };
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "أرسل محتوى الملف في الحقل content" }, { status: 400 });
  }
  const saved = saveCookieFile(body.content, body.path ?? null);
  if (!saved.ok) return NextResponse.json({ error: saved.reason }, { status: 400 });

  const coverage = cookieCoverage(body.content);
  return NextResponse.json({
    ok: true,
    path: saved.path,
    count: saved.count,
    sessions: coverage.sessions,
    platforms: coverage.platforms,
  });
}
