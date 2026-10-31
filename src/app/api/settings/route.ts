import { NextResponse } from "next/server";
import { coerceSettingsPatch, getSettings, updateSettings } from "@/lib/settings";
import { engine } from "@/lib/engine";
import { allowedRoots } from "@/lib/safe-path";
import { db } from "@/db";
import { settings as settingsTable } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET() {
  const current = await getSettings();
  return NextResponse.json({ ...current, allowedRoots: allowedRoots([current.outputDir]) });
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }

  const current = await getSettings();
  const { patch, rejected, reasons } = coerceSettingsPatch(body, current.outputDir);
  const explain = (keys: string[]) => keys.map((key) => `${key}: ${reasons[key] ?? "قيمة غير صالحة"}`).join(" | ");
  if (Object.keys(patch).length === 0 && rejected.length > 0) {
    return NextResponse.json(
      { error: `قيم مرفوضة — ${explain(rejected)}`, rejected, reasons },
      { status: 400 },
    );
  }

  const [updated] = await db
    .update(settingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settingsTable.id, current.id))
    .returning();

  engine.schedulePump();
  return NextResponse.json({ ...(updated ?? current), rejected, reasons });
}

/** Kept for backwards compatibility with the old `updateSettings` helper. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(await updateSettings(body));
}
