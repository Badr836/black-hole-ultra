import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { downloads } from "@/db/schema";
import { engine, fileExists } from "@/lib/engine";
import { getSettings } from "@/lib/settings";
import {
  buildSelector,
  normalizeContainer,
  sanitizePlaylistItems,
} from "@/lib/format-selector";
import { allowedRoots, isServableFile, resolveOutputDir } from "@/lib/safe-path";
import { statfsSync } from "node:fs";
import { normalizeAudioLanguage, normalizeCodecs, normalizeVideoRange } from "@/lib/hls";

export const runtime = "nodejs";

function freeSpace(dir: string): number | null {
  try {
    const info = statfsSync(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

export async function GET() {
  const rows = await db.select().from(downloads).orderBy(desc(downloads.createdAt)).limit(200);
  const s = await getSettings();
  const roots = allowedRoots([s.outputDir]);
  const items = rows.map((row) => ({
    ...row,
    fileAvailable: row.status === "completed" && isServableFile(row.filePath, roots) && fileExists(row.filePath),
    running: engine.isRunning(row.id),
  }));
  const stats = await engine.libraryStats();
  return NextResponse.json({
    items,
    stats: { ...stats, freeSpace: freeSpace(s.outputDir), outputDir: s.outputDir },
    active: engine.activeCount,
  });
}

type CreateBody = {
  url?: string;
  title?: string;
  thumbnail?: string | null;
  uploader?: string | null;
  duration?: number | null;
  kind?: string;
  quality?: string;
  container?: string;
  audioFormatId?: string | null;
  mergeAudio?: boolean;
  subtitles?: boolean;
  playlist?: boolean;
  playlistItems?: string | null;
  outputDir?: string;
  metadata?: Record<string, unknown>;
  /** Watch-page URL, used to derive Referer/Origin for protected HLS. */
  pageUrl?: string | null;
  /** Per-download HLS overrides (audio language / range / codecs). */
  hlsAudioLang?: string | null;
  hlsRange?: string | null;
  hlsCodecs?: string | null;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateBody;
    const url = (body.url ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      return NextResponse.json({ error: "رابط غير صالح: يجب أن يبدأ بـ http:// أو https://" }, { status: 400 });
    }

    const kind = body.kind === "audio" ? "audio" : body.kind === "image" ? "image" : "video";
    const container = normalizeContainer(kind, body.container ?? "");
    const quality = (body.quality ?? "best").trim();
    if (!/^(best|\d{3,4}|id:[A-Za-z0-9._-]{1,40})$/.test(quality)) {
      return NextResponse.json({ error: "جودة غير صالحة." }, { status: 400 });
    }

    let playlistItems: string | null = null;
    try {
      playlistItems = sanitizePlaylistItems(body.playlistItems ?? null);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "عناصر قائمة تشغيل غير صالحة" },
        { status: 400 },
      );
    }

    const s = await getSettings();
    const target = resolveOutputDir(body.outputDir, s.outputDir, allowedRoots([s.outputDir]));
    if (!target.ok) {
      return NextResponse.json({ error: `مجلد الحفظ مرفوض: ${target.reason}` }, { status: 400 });
    }

    let selector: string;
    let label: string;
    try {
      ({ selector, label } = buildSelector({
        kind,
        quality,
        container,
        audioFormatId: body.audioFormatId ?? null,
        mergeAudio: body.mergeAudio !== false,
      }));
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "اختيار صيغة غير صالح" },
        { status: 400 },
      );
    }

    const duplicate = await db
      .select({ id: downloads.id })
      .from(downloads)
      .where(
        and(
          eq(downloads.url, url),
          eq(downloads.formatSelector, selector),
          inArray(downloads.status, ["queued", "downloading", "converting"]),
        ),
      )
      .limit(1);
    if (duplicate.length > 0) {
      return NextResponse.json(
        { error: `هذا الرابط بالصيغة نفسها موجود بالفعل في الطابور (#${duplicate[0].id}).` },
        { status: 409 },
      );
    }

    // Optional HLS session/selection hints. They live in `metadata` so the
    // engine can read them without a migration per option.
    const metadata: Record<string, unknown> = { ...(body.metadata ?? {}) };
    if (body.pageUrl) {
      const page = String(body.pageUrl).trim();
      let parsed: URL | null = null;
      try {
        parsed = new URL(page);
      } catch {
        parsed = null;
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        return NextResponse.json({ error: "رابط صفحة المشاهدة غير صالح." }, { status: 400 });
      }
      metadata.pageUrl = parsed.toString();
    }
    const audioLang = body.hlsAudioLang ? normalizeAudioLanguage(body.hlsAudioLang) : null;
    if (body.hlsAudioLang && !audioLang) {
      return NextResponse.json({ error: "رمز لغة الصوت غير صالح (مثال: ar، en)." }, { status: 400 });
    }
    const videoRange = body.hlsRange ? normalizeVideoRange(body.hlsRange) : null;
    if (body.hlsRange && !videoRange) {
      return NextResponse.json({ error: "مدى الفيديو غير صالح (SDR أو HDR)." }, { status: 400 });
    }
    const codecs = body.hlsCodecs ? normalizeCodecs(body.hlsCodecs) : null;
    if (body.hlsCodecs && !codecs) {
      return NextResponse.json({ error: "اسم الترميز غير صالح (مثال: hvc1)." }, { status: 400 });
    }
    if (audioLang) metadata.hlsAudioLang = audioLang;
    if (videoRange) metadata.hlsRange = videoRange;
    if (codecs) metadata.hlsCodecs = codecs;

    const now = new Date();
    const [row] = await db
      .insert(downloads)
      .values({
        url,
        title: (body.title ?? "Untitled").slice(0, 300),
        thumbnail: body.thumbnail ?? null,
        uploader: body.uploader ?? null,
        duration: Number.isFinite(body.duration) ? Math.trunc(body.duration as number) : null,
        kind,
        formatSelector: selector,
        qualityLabel: label,
        container,
        subtitles: Boolean(body.subtitles),
        playlist: Boolean(body.playlist),
        playlistItems: body.playlist ? playlistItems : null,
        outputDir: target.path,
        metadata,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    engine.schedulePump();
    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "فشل الإضافة" },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { action?: string; deleteFiles?: boolean };
    switch (body.action) {
      case "pauseAll":
        await engine.pauseAll();
        break;
      case "resumeAll":
        await engine.resumeAll();
        break;
      case "clearFinished":
        await engine.clearFinished(Boolean(body.deleteFiles));
        break;
      default:
        return NextResponse.json({ error: "إجراء غير معروف" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "فشل الإجراء" },
      { status: 500 },
    );
  }
}
