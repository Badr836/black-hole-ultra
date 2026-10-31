import { NextResponse } from "next/server";
import { resolveBinary, binaryVersion } from "@/lib/binaries";
import { getSettings } from "@/lib/settings";
import { engine } from "@/lib/engine";
import { currentVersion, sqlite } from "@/db";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSettings();
  engine.schedulePump();
  const ytdlp = resolveBinary("yt-dlp", s.ytdlpPath);
  const gallerydl = resolveBinary("gallery-dl", s.gallerydlPath);
  const ffmpeg = resolveBinary("ffmpeg", s.ffmpegPath);
  const siblingFfprobe = ffmpeg
    ? path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : null;
  const ffprobe = resolveBinary("ffprobe", siblingFfprobe);
  const nm3u8dl = resolveBinary("N_m3u8DL-RE", null);
  const [ytdlpVersion, ffmpegVersion, ffprobeVersion, gallerydlVersion, nm3u8dlVersion] = await Promise.all([
    binaryVersion(ytdlp, ["--version"]),
    binaryVersion(ffmpeg, ["-version"]),
    binaryVersion(ffprobe, ["-version"]),
    binaryVersion(gallerydl, ["--version"]),
    binaryVersion(nm3u8dl, ["--version"]).then((v) => (v ? v.split("+")[0] : v)),
  ]);

  let schemaVersion = 0;
  try {
    schemaVersion = currentVersion(sqlite);
  } catch {
    /* reported as 0 */
  }

  return NextResponse.json({
    platform: process.platform,
    node: process.version,
    ytdlp: { path: ytdlp, version: ytdlpVersion, ok: Boolean(ytdlp && ytdlpVersion) },
    ffmpeg: {
      path: ffmpeg,
      version: ffmpegVersion?.replace(/ Copyright.*$/, ""),
      ok: Boolean(ffmpeg && ffmpegVersion),
    },
    ffprobe: {
      path: ffprobe,
      version: ffprobeVersion?.replace(/ Copyright.*$/, ""),
      ok: Boolean(ffprobe && ffprobeVersion),
    },
    gallerydl: { path: gallerydl, version: gallerydlVersion, ok: Boolean(gallerydl && gallerydlVersion) },
    nm3u8dl: { path: nm3u8dl, version: nm3u8dlVersion, ok: Boolean(nm3u8dl && nm3u8dlVersion) },
    mediaToolsOk: Boolean(ffmpeg && ffmpegVersion && ffprobe && ffprobeVersion),
    outputDir: s.outputDir,
    allowInsecureTls: s.allowInsecureTls,
    providerPreference: s.providerPreference,
    cookiesPath: s.cookiesPath,
    database: { engine: "sqlite", schemaVersion },
    active: engine.activeCount,
  });
}
