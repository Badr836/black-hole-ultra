import { NextResponse } from "next/server";
import { exportSettings, getSettings, parseBackup, updateSettings } from "@/lib/settings";
import { engine } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download a portable settings backup (machine-specific binary paths excluded). */
export async function GET() {
  const backup = await exportSettings();
  return new NextResponse(JSON.stringify(backup, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="blackhole-settings-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Restore from a previously exported backup. */
export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "ملف JSON غير صالح" }, { status: 400 });
  }

  const parsed = parseBackup(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 400 });

  const before = await getSettings();
  const updated = await updateSettings(parsed.payload);
  engine.schedulePump();

  return NextResponse.json({
    ok: true,
    changed: Object.keys(parsed.payload).filter((key) => {
      const beforeValue = (before as unknown as Record<string, unknown>)[key];
      const afterValue = (updated as unknown as Record<string, unknown>)[key];
      return beforeValue !== afterValue;
    }),
    settings: updated,
  });
}
