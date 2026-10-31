import { NextResponse } from "next/server";
import os from "node:os";
import { generateToken, readTokenFile, TOKEN_FILE, writeTokenFile } from "@/lib/access-token";
import { readLiveToken } from "@/lib/access-node";

export const runtime = "nodejs";

/**
 * Access-token management (the missing UI for the round-4 auto token).
 *
 * GET  → where the token comes from, the current value, and the LAN URLs to
 *        open from another device (with `?token=` already appended).
 * POST → `{ action: "rotate" }` generates a new token, persists it (0600) and
 *        updates `process.env.BLACKHOLE_TOKEN` so the middleware — which runs in
 *        the same Node process — enforces the new value immediately.
 *
 * The route itself is behind the middleware, so a LAN client needs the token to
 * read or rotate it. Loopback (the machine itself) is always allowed.
 */

function lanAddresses(port: string): string[] {
  const urls: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}

function snapshot() {
  const envToken = process.env.BLACKHOLE_TOKEN?.trim() || null;
  // `readLiveToken` reflects a rotation immediately (same source the middleware
  // verifies against); `readTokenFile` covers the "file exists, env empty" case.
  const fileToken = readLiveToken() ?? readTokenFile();
  const port = process.env.PORT ?? "3000";
  const token = envToken ?? fileToken;
  const source = envToken ? ("env" as const) : fileToken ? ("file" as const) : ("none" as const);
  const binding = (process.env.HOSTNAME ?? "").trim();
  return {
    ok: true,
    /** True when the app listens on a non-loopback address. */
    publicBind: !binding || binding === "0.0.0.0" || binding === "::",
    bind: binding || "0.0.0.0",
    source,
    hasToken: Boolean(token),
    autoTokenDisabled: process.env.BLACKHOLE_AUTO_TOKEN === "0",
    allowUnauthenticated: process.env.BLACKHOLE_ALLOW_UNAUTHENTICATED === "1",
    token,
    tokenFile: TOKEN_FILE,
    tokenLength: token?.length ?? 0,
    urls: lanAddresses(port),
    port,
  };
}

export async function GET() {
  return NextResponse.json(snapshot());
}

export async function POST(req: Request) {
  let action = "";
  try {
    const body = (await req.json()) as { action?: string };
    action = body.action ?? "";
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }

  if (action !== "rotate") {
    return NextResponse.json({ error: "إجراء غير معروف" }, { status: 400 });
  }

  const token = generateToken();
  const written = writeTokenFile(token);
  process.env.BLACKHOLE_TOKEN = token;

  return NextResponse.json({
    ...snapshot(),
    rotated: true,
    persisted: Boolean(written),
    note: written
      ? "تم تدوير الرمز وحفظه. الأجهزة الأخرى تحتاج الرمز الجديد — الروابط أدناه تتضمنه."
      : "تم تدوير الرمز في الذاكرة فقط (تعذّر الحفظ على القرص). سيُفقد بعد إعادة التشغيل.",
  });
}
