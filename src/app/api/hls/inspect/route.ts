import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { inspectHlsManifest, isHlsUrl, looksLikeDrmManifest, parseHeaderLines } from "@/lib/hls";
import { buildHeaderCandidates, describeProbe, pickWorkingHeaders } from "@/lib/site-session";
import { buildCookieHeader } from "@/lib/hls";
import { existsSync, readFileSync } from "node:fs";

export const runtime = "nodejs";

/**
 * POST /api/hls/inspect  { url, pageUrl? }
 *
 * Answers "what is actually in this stream?" before the user commits:
 *   - which resolutions / ranges / codecs the master playlist offers;
 *   - which audio languages exist (so `--select-audio lang=ar` is a real choice);
 *   - whether it is DRM-protected (then we say no, clearly);
 *   - which header candidate the origin accepts (user / page / same-origin).
 *
 * Read-only: one manifest fetch (plus at most three tiny probes).
 */
export async function POST(req: Request) {
  let body: { url?: string; pageUrl?: string | null };
  try {
    body = (await req.json()) as { url?: string; pageUrl?: string | null };
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }

  const url = (body.url ?? "").trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return NextResponse.json({ error: "رابط غير صالح." }, { status: 400 });
  }
  if (!isHlsUrl(url)) {
    return NextResponse.json(
      { error: "هذا الرابط ليس بث HLS (m3u8) — الفحص متاح لروابط m3u8 فقط." },
      { status: 400 },
    );
  }

  const settings = await getSettings();
  const userHeaders = parseHeaderLines(settings.hlsHeaders);
  let cookie: string | null = null;
  if (settings.hlsUseCookies && settings.cookiesPath && existsSync(settings.cookiesPath)) {
    try {
      cookie = buildCookieHeader(readFileSync(settings.cookiesPath, "utf8"), url);
    } catch {
      cookie = null;
    }
  }

  const candidates = buildHeaderCandidates({
    userHeaders,
    pageUrl: body.pageUrl ?? null,
    manifestUrl: url,
    auto: settings.hlsAutoHeaders !== false,
  });
  if (cookie) {
    for (const candidate of candidates) if (!candidate.headers.Cookie) candidate.headers.Cookie = cookie;
  }

  const probe = await pickWorkingHeaders(candidates, url);
  const headersForFetch = probe.chosen?.headers ?? {};
  const probeNote = describeProbe(probe);

  let text = "";
  let status = 0;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url, {
      headers: { "User-Agent": "BlackHoleUltra/1.0", ...headersForFetch },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    status = response.status;
    if (response.ok) text = (await response.text()).slice(0, 512 * 1024);
  } catch (error) {
    return NextResponse.json(
      {
        error: `تعذّر جلب المانيفست: ${error instanceof Error ? error.message : String(error)}`,
        headersUsed: probe.chosen?.label ?? null,
        probeNote,
      },
      { status: 502 },
    );
  }

  if (!text) {
    return NextResponse.json(
      {
        error:
          status === 403 || status === 401
            ? `الخادم رفض الطلب (${status}). جرّب لصق رابط صفحة المشاهدة أو ترويسة Referer في الإعدادات.`
            : `تعذّر قراءة المانيفست (HTTP ${status}).`,
        headersUsed: probe.chosen?.label ?? null,
        probeNote,
        attempts: probe.attempts,
      },
      { status: 502 },
    );
  }

  if (looksLikeDrmManifest(text)) {
    return NextResponse.json(
      {
        drm: true,
        error: "هذا البث محمي بـ DRM (Widevine/FairPlay/PlayReady) — التطبيق لا يتجاوزه ولا ينزّله.",
        headersUsed: probe.chosen?.label ?? null,
        probeNote,
      },
      { status: 422 },
    );
  }

  const info = inspectHlsManifest(text, url);
  return NextResponse.json({
    ok: true,
    url,
    isMaster: info.isMaster,
    variants: info.variants,
    audio: info.audio,
    drm: info.drm,
    segmentCount: info.segmentCount,
    headersUsed: probe.chosen?.label ?? null,
    headersNote: probe.chosen?.note ?? null,
    probeNote,
    attempts: probe.attempts,
    /** Ready-made settings hints for the UI. */
    suggestions: {
      heights: [...new Set(info.variants.map((variant) => variant.height).filter(Boolean))].sort(
        (a, b) => (b as number) - (a as number),
      ),
      ranges: [...new Set(info.variants.map((variant) => variant.range).filter(Boolean))],
      codecs: [...new Set(info.variants.map((variant) => variant.codecs).filter(Boolean))],
      audioLanguages: [...new Set(info.audio.map((rendition) => rendition.language).filter(Boolean))],
    },
  });
}
