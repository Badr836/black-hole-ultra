import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { db } from "@/db";
import { downloads } from "@/db/schema";
import { getSettings } from "@/lib/settings";
import { allowedRoots, isServableFile, safeReal } from "@/lib/safe-path";
import {
  UNSATISFIABLE_RANGE_HEADERS,
  contentRangeHeader,
  parseRange,
} from "@/lib/http-range";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".opus": "audio/ogg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wma": "audio/x-ms-wma",
};

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  }

  const [row] = await db.select().from(downloads).where(eq(downloads.id, id)).limit(1);
  if (!row?.filePath) return NextResponse.json({ error: "الملف غير موجود" }, { status: 404 });

  const s = await getSettings();
  // Never stream a path outside the download roots, even if the row was tampered with.
  if (!isServableFile(row.filePath, allowedRoots([s.outputDir, row.outputDir]))) {
    return NextResponse.json({ error: "مسار الملف خارج النطاق المسموح" }, { status: 403 });
  }

  let size: number;
  try {
    const info = await stat(safeReal(row.filePath));
    if (!info.isFile()) return NextResponse.json({ error: "ليس ملفاً" }, { status: 404 });
    size = info.size;
  } catch {
    return NextResponse.json({ error: "الملف غير موجود على القرص" }, { status: 404 });
  }

  const ext = path.extname(row.filePath).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const url = new URL(req.url);
  const asAttachment = url.searchParams.get("download") === "1";

  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (asAttachment) {
    headers["Content-Disposition"] =
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(row.filePath))}`;
  }

  const range = parseRange(req.headers.get("range"), size);
  if (range.kind === "invalid") {
    return new NextResponse(null, { status: 416, headers: UNSATISFIABLE_RANGE_HEADERS(size) });
  }
  if (range.kind === "partial") {
    const stream = createReadStream(row.filePath, { start: range.start, end: range.end });
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": contentRangeHeader(range.start, range.end, size),
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }

  const stream = createReadStream(row.filePath);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...headers, "Content-Length": String(size) },
  });
}
