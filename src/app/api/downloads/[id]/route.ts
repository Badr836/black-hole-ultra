import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { downloads } from "@/db/schema";
import { engine } from "@/lib/engine";
import { getSettings } from "@/lib/settings";
import { allowedRoots, isServableFile } from "@/lib/safe-path";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  const [row] = await db.select().from(downloads).where(eq(downloads.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "غير موجود" }, { status: 404 });
  const s = await getSettings();
  return NextResponse.json({
    ...row,
    fileAvailable: isServableFile(row.filePath, allowedRoots([s.outputDir])),
    running: engine.isRunning(row.id),
  });
}

export async function POST(req: Request, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });

  let action: string | undefined;
  try {
    ({ action } = (await req.json()) as { action?: string });
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }

  switch (action) {
    case "pause":
      await engine.pause(id);
      break;
    case "resume":
    case "retry":
      await engine.resume(id);
      break;
    case "cancel":
      await engine.cancel(id);
      break;
    case "retry-missing": {
      const result = await engine.retryMissing(id);
      if (!result.ok) {

        return NextResponse.json({ error: result.reason ?? "تعذّرت إعادة المحاولة" }, { status: 409 });
      }
      break;
    }
    default:
      return NextResponse.json({ error: "إجراء غير معروف" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  const deleteFile = new URL(req.url).searchParams.get("deleteFile") === "1";
  await engine.remove(id, { deleteFile });
  return NextResponse.json({ ok: true, deleteFile });
}
