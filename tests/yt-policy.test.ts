import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveFilePath,
  parseAria2Progress,
  parseDestinationMarker,
  COOKIE_PERMISSION_MESSAGE,
  downloadArchiveArgs,
  externalDownloaderArgs,
  isArchiveSkip,
  isCookiePermissionError,
  isYouTubeUrl,
  looksLikeDashOrHls,
  looksLikeYouTubeClientBlock,
  parsePlaylistSpecCount,
  playlistCompletionNote,
  playlistTotalFromLog,
  shouldRotateYouTubeClient,
  skipCompletionNote,
  sponsorBlockArgs,
  youTubeClientArgs,
} from "../src/lib/yt-policy";

/* --------------------------------------------------------------- YouTube */

test("detects YouTube URLs (and only those)", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "https://m.youtube.com/watch?v=abc",
    "https://music.youtube.com/watch?v=abc",
  ]) {
    assert.equal(isYouTubeUrl(url), true, url);
  }
  for (const url of [
    "https://vimeo.com/123",
    "https://youtube.com.evil.example/watch?v=1",
    "https://notyoutube.com/watch?v=1",
    "not a url",
  ]) {
    assert.equal(isYouTubeUrl(url), false, url);
  }
});

test("403 / challenge failures are recognised, unavailable videos are not", () => {
  assert.equal(looksLikeYouTubeClientBlock("ERROR: HTTP Error 403: Forbidden"), true);
  assert.equal(looksLikeYouTubeClientBlock("n challenge solving failed: Some formats may be missing"), true);
  assert.equal(looksLikeYouTubeClientBlock("WARNING: [youtube] Unable to extract nsig"), true);
  assert.equal(looksLikeYouTubeClientBlock("ERROR: Video unavailable"), false);
  assert.equal(looksLikeYouTubeClientBlock("ERROR: Private video. Sign in if you've been granted access"), false);
  assert.equal(looksLikeYouTubeClientBlock("ERROR: Unsupported URL"), false);
});

test("rotation happens once, only after failure, only on YouTube", () => {
  const base = { url: "https://www.youtube.com/watch?v=abc", exitCode: 1, rawError: "ERROR: HTTP Error 403: Forbidden", metadata: null };

  const first = shouldRotateYouTubeClient(base);
  assert.equal(first.rotate, true);
  assert.equal(first.rotate && first.client, "android_vr");

  // success → no rotation
  assert.equal(shouldRotateYouTubeClient({ ...base, exitCode: 0 }).rotate, false);
  // already rotated → never again
  assert.equal(
    shouldRotateYouTubeClient({ ...base, metadata: { ytClient: "android_vr" } }).rotate,
    false,
  );
  // a *different* client failed first → still allowed to try the fallback once
  const fromOtherClient = shouldRotateYouTubeClient({ ...base, metadata: { ytClient: "web_safari" } });
  assert.equal(fromOtherClient.rotate, true);
  assert.match(fromOtherClient.rotate ? fromOtherClient.reason : "", /web_safari/);
  assert.equal(
    shouldRotateYouTubeClient({ ...base, metadata: { ytAttempt: 1 } }).rotate,
    false,
  );
  // other sites → no YouTube-specific hack
  assert.equal(shouldRotateYouTubeClient({ ...base, url: "https://vimeo.com/1" }).rotate, false);
  // unrelated error text → keep the normal retry path
  assert.equal(shouldRotateYouTubeClient({ ...base, rawError: "ERROR: Video unavailable" }).rotate, false);
  // provider fallback in flight → don't fight it
  assert.equal(
    shouldRotateYouTubeClient({ ...base, metadata: { providerFallback: true } }).rotate,
    false,
  );
});

test("player client arguments are only emitted for sane values", () => {
  assert.deepEqual(youTubeClientArgs("android_vr"), ["--extractor-args", "youtube:player_client=android_vr"]);
  assert.deepEqual(youTubeClientArgs(null), []);
  assert.deepEqual(youTubeClientArgs(""), []);
  assert.deepEqual(youTubeClientArgs("bad value; rm -rf /"), []);
});

/* -------------------------------------------------------- Download archive */

test("archive arguments are opt-in and point inside the output folder", () => {
  assert.deepEqual(downloadArchiveArgs(false, "/videos"), []);
  const args = downloadArchiveArgs(true, "/videos");
  assert.deepEqual(args, ["--download-archive", archiveFilePath("/videos")]);
  assert.equal(archiveFilePath("/videos").endsWith(".blackhole-archive.txt"), true);
  assert.deepEqual(downloadArchiveArgs(true, "/videos", true), []);
});

test('"already recorded in the archive" is detected as a skip, not an error', () => {
  assert.equal(
    isArchiveSkip("[download] My Video has already been recorded in the archive"),
    true,
  );
  assert.equal(isArchiveSkip("[download] 100% of 12MiB"), false);
});

/* ------------------------------------------------------------ SponsorBlock */

test("skip completion never reads as a failure", () => {
  assert.match(skipCompletionNote(true), /أرشيف/);
  assert.match(skipCompletionNote(false), /موجود مسبقاً/);
  for (const note of [skipCompletionNote(true), skipCompletionNote(false)]) {
    assert.match(note, /^تم تخطيه/);
    assert.equal(/فشل/.test(note), false);
  }
});

test("sponsorblock is off by default and never applied to non-YouTube links", () => {
  assert.deepEqual(sponsorBlockArgs("off", true), []);
  assert.deepEqual(sponsorBlockArgs(null, true), []);
  assert.deepEqual(sponsorBlockArgs("remove", false), []);
  assert.deepEqual(sponsorBlockArgs("remove", true), ["--sponsorblock-remove", "sponsor"]);
  assert.deepEqual(sponsorBlockArgs("mark", true), ["--sponsorblock-mark", "sponsor"]);
});

/* ---------------------------------------------------------------- Cookies */

test("cookie permission failures map to actionable Arabic guidance", () => {
  assert.equal(
    isCookiePermissionError("[Errno 13] Permission denied: '/home/u/.config/chromium/Cookies'"),
    true,
  );
  assert.equal(isCookiePermissionError("ERROR: Failed to decrypt with DPAPI"), true);
  assert.equal(isCookiePermissionError("ERROR: HTTP Error 404"), false);
  assert.match(COOKIE_PERMISSION_MESSAGE, /أغلق المتصفح/);
});

/* ------------------------------------------------------- Playlist integrity */

test("playlist expected count comes from the spec or from yt-dlp's log", () => {
  assert.equal(parsePlaylistSpecCount("1-5"), 5);
  assert.equal(parsePlaylistSpecCount("1-3,7,9-10"), 6);
  assert.equal(parsePlaylistSpecCount(null), null);
  assert.equal(parsePlaylistSpecCount(""), null);

  assert.equal(playlistTotalFromLog("[download] Downloading item 3 of 12"), 12);
  assert.equal(playlistTotalFromLog("Downloading item 1 of 4\nDownloading item 2 of 4"), 4);
  assert.equal(playlistTotalFromLog("nothing here"), null);
});

test("incomplete playlists produce a note instead of a silent success", () => {
  assert.match(String(playlistCompletionNote(10, 7)), /7 من 10/);
  assert.equal(playlistCompletionNote(10, 10), null);
  assert.equal(playlistCompletionNote(10, 12), null);
  assert.equal(playlistCompletionNote(null, 3), null);
});

/* ------------------------------------------------------ External downloader */

test("aria2c is opt-in, uses the http: prefix and never touches DASH/HLS", () => {
  assert.deepEqual(externalDownloaderArgs("off", "/usr/bin/aria2c"), []);
  assert.deepEqual(externalDownloaderArgs("aria2c", null), []);
  assert.deepEqual(
    externalDownloaderArgs("aria2c", "/usr/bin/aria2c", { isDashOrHls: true }),
    [],
  );
  const args = externalDownloaderArgs("aria2c", "/usr/bin/aria2c");
  assert.equal(args[0], "--downloader");
  assert.equal(args[1], "http:/usr/bin/aria2c");
  assert.equal(args[1].startsWith("http:"), true);
  assert.equal(args[2], "--downloader-args");
});

test("BHDEST marker gives the external-downloader poller a target", () => {
  assert.deepEqual(parseDestinationMarker("BHDEST:/videos/a.mp4|1048576"), { path: "/videos/a.mp4", size: 1048576 });
  assert.deepEqual(parseDestinationMarker("BHDEST:C:\\v\\b.mkv|0"), { path: "C:\\v\\b.mkv", size: 0 });
  assert.deepEqual(parseDestinationMarker("BHDEST:/videos/a.mp4|NA"), { path: "/videos/a.mp4", size: 0 });
  assert.equal(parseDestinationMarker("/videos/a.mp4"), null);
  assert.equal(parseDestinationMarker("BHDEST:"), null);
});

test("aria2c readout is parsed into real progress", () => {
  const one = parseAria2Progress("[#30b124 13MiB/14MiB(95%) CN:1 DL:1.9MiB ETA:1s]");
  assert.equal(one?.percent, 95);
  assert.equal(one?.speed, "1.9 MB/s");

  // multiple carriage-return updates in one chunk → last wins
  const many = parseAria2Progress("[#aaaaaa 1MiB/14MiB(7%) CN:2 DL:900KiB]\r[#aaaaaa 9MiB/14MiB(64%) CN:2 DL:1.2MiB]");
  assert.equal(many?.percent, 64);

  assert.equal(parseAria2Progress("[download] 100% of 14MiB in 00:00:10"), null);
  assert.equal(parseAria2Progress("random stderr"), null);
});

test("DASH/HLS detection", () => {
  assert.equal(looksLikeDashOrHls("bestvideo+bestaudio", "mp4"), false);
  assert.equal(looksLikeDashOrHls("hls-1080", "mp4"), true);
  assert.equal(looksLikeDashOrHls("best", "m3u8"), true);
  assert.equal(looksLikeDashOrHls("dash/best", "mp4"), true);
});
