import { NextResponse } from "next/server";
import {
  cookieCoverage,
  cookiesHint,
  defaultCookiePath,
  readCookieFile,
  saveCookieFile,
} from "@/lib/cookies";
import { getSettings } from "@/lib/settings";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings as settingsTable } from "@/db/schema";

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
  const s = await getSettings();
  const saved = saveCookieFile(body.content, body.path ?? null);
  if (!saved.ok) return NextResponse.json({ error: saved.reason }, { status: 400 });

  // Persist the path the file was actually written to, so the analyzers and the
  // download engine use it without the user having to type it into Settings.
  if (!s.cookiesPath?.trim()) {
    await db.update(settingsTable).set({ cookiesPath: saved.path, updatedAt: new Date() });
  }

  const coverage = cookieCoverage(body.content);
  return NextResponse.json({
    ok: true,
    path: saved.path,
    count: saved.count,
    sessions: coverage.sessions,
    platforms: coverage.platforms,
  });
}
