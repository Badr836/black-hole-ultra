import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCookieHeader,
  buildHlsSelectArgs,
  buildNm3u8dlArgs,
  parseHeaderLines,
  DRM_REFUSAL_MESSAGE,
  friendlyHlsError,
  isHlsUrl,
  isOutputFileFor,
  isPermanentHlsFailure,
  looksLikeDrmFailure,
  looksLikeDrmManifest,
  overallHlsPercent,
  parseNm3u8dlProgress,
  parseSize,
  safeSaveName,
  updateHlsTracks,
  type HlsTrackState,
} from "../src/lib/hls";

test("only real HLS links are routed to the HLS engine", () => {
  for (const url of [
    "https://cdn.example.com/live/index.m3u8",
    "https://cdn.example.com/vod/master.M3U8?token=abc",
    "https://cdn.example.com/path/playlist.m3u",
  ]) {
    assert.equal(isHlsUrl(url), true, url);
  }
  for (const url of [
    "https://www.youtube.com/watch?v=abc",
    "https://example.com/page",
    "https://example.com/video.mp4",
    "not a url",
  ]) {
    assert.equal(isHlsUrl(url), false, url);
  }
});

test("command line is safe, non-interactive and complete", () => {
  const args = buildNm3u8dlArgs({
    url: "https://cdn.example.com/index.m3u8",
    outputDir: "/videos",
    saveName: "clip",
    threadCount: 64,
    speedLimit: "2M",
    ffmpegPath: "/usr/bin/ffmpeg",
    headers: { Referer: "https://site.example/", "X-Bad": "a\nb" },
  });
  assert.equal(args[0], "https://cdn.example.com/index.m3u8");
  // Without this the tool crashes when stdout is a pipe (Spectre.Console).
  assert.equal(args.includes("--force-ansi-console"), true);
  assert.equal(args[args.indexOf("--thread-count") + 1], "32");
  assert.equal(args[args.indexOf("--save-dir") + 1], "/videos");
  assert.equal(args[args.indexOf("--max-speed") + 1], "2M");
  assert.equal(args[args.indexOf("--ffmpeg-binary-path") + 1], "/usr/bin/ffmpeg");
  // header injection via newline must be dropped
  assert.equal(args.includes("X-Bad: a\nb"), false);
  assert.equal(args.includes("Referer: https://site.example/"), true);
});

test("progress lines are parsed into bytes and percent", () => {
  const line =
    "Vid 1280x720 | 2320 Kbps ━━━ 12/41 29.27% 13.31MB/45.46MB5.55MBps00:00:05";
  const progress = parseNm3u8dlProgress(line);
  assert.equal(progress?.percent, 29.27);
  assert.equal(progress?.downloadedBytes, Math.round(13.31 * 1024 ** 2));
  assert.equal(progress?.totalBytes, Math.round(45.46 * 1024 ** 2));
  assert.equal(progress?.speed, "5.55MB/s");

  assert.equal(parseNm3u8dlProgress("INFO : Done"), null);
  assert.equal(parseSize("1.5GB"), Math.round(1.5 * 1024 ** 3));
  assert.equal(parseSize("nope"), null);
});

test("DRM manifests are refused, plain ones are not", () => {
  assert.equal(looksLikeDrmManifest('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"'), true);
  assert.equal(looksLikeDrmManifest('#EXT-X-KEY:METHOD=SAMPLE-AES'), true);
  assert.equal(
    looksLikeDrmManifest('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'),
    false,
    "AES-128 with a plain key is not DRM",
  );
  assert.equal(looksLikeDrmManifest("#EXTM3U\n#EXTINF:5,\nseg1.ts"), false);
  assert.match(DRM_REFUSAL_MESSAGE, /DRM/);
  assert.equal(looksLikeDrmFailure("ERROR: failed to decrypt segment"), true);
});

test("HLS errors become actionable Arabic messages", () => {
  assert.match(friendlyHlsError("HTTP 403 Forbidden"), /403/);
  assert.match(friendlyHlsError("404 Not Found"), /404/);
  assert.match(friendlyHlsError("something odd happened"), /فشل تنزيل HLS/);
});

test("output detection and filename sanitising", () => {
  assert.equal(isOutputFileFor("clip.mp4", "clip"), true);
  assert.equal(isOutputFileFor("clip.mkv", "clip"), true);
  assert.equal(isOutputFileFor("clip.txt", "clip"), false);
  assert.equal(isOutputFileFor("other.mp4", "clip"), false);
  assert.equal(isOutputFileFor("clip.mp4.part", "clip"), false);

  assert.equal(safeSaveName('a/b:c*?"<>|d'), "a b c d");
  assert.equal(safeSaveName("   "), "hls-video");
  assert.equal(safeSaveName("..hidden"), "hidden");
});

test("multi-track progress does not jump to 99.9% after the first track", () => {
  let state: HlsTrackState = { tracks: 0, started: 0, counting: false };
  state = updateHlsTracks(state, "INFO : Selected streams:");
  state = updateHlsTracks(state, "INFO : Vid 1280x720 | 2320 Kbps | avc1 | 41 Segments");
  state = updateHlsTracks(state, "INFO : Aud 128 Kbps | mp4a | 2 Segments");
  assert.equal(state.tracks, 2);

  state = updateHlsTracks(state, "INFO : Save Name: clip");
  state = updateHlsTracks(state, "WARN : Reading media info...");
  assert.equal(state.started, 1);
  // first track at 100% is only half of the job
  assert.equal(Math.round(overallHlsPercent(state, 100)), 50);

  state = updateHlsTracks(state, "WARN : Reading media info...");
  assert.equal(Math.round(overallHlsPercent(state, 50)), 75);
  assert.equal(Math.round(overallHlsPercent(state, 100)), 99.9 < 100 ? 100 : 99.9);
});

test("single-track progress is reported as-is", () => {
  const state: HlsTrackState = { tracks: 1, started: 1, counting: false };
  assert.equal(overallHlsPercent(state, 43.2), 43.2);
  assert.equal(overallHlsPercent(state, 120), 99.9);
});

test("the tool's own 404 wording is recognised as permanent", () => {
  assert.equal(
    isPermanentHlsFailure("WARN : Response status code does not indicate success: 404 (Not Found). (1/10)"),
    true,
  );
  assert.equal(isPermanentHlsFailure("WARN : Response status code does not indicate success: 403 (Forbidden)."), true);
  assert.equal(isPermanentHlsFailure("INFO : Loading URL: https://x/y.m3u8"), false);
  assert.equal(isPermanentHlsFailure("WARN : retrying segment 3"), false);
});

test("quality choice maps to --select-video instead of --auto-select", () => {
  assert.deepEqual(buildHlsSelectArgs("1080p", "video"), [
    "--select-video",
    "res=1080*:for=best",
    "--select-audio",
    "for=best",
  ]);
  assert.deepEqual(buildHlsSelectArgs("720", "video"), ["--select-video", "res=720*:for=best", "--select-audio", "for=best"]);
  // Non-numeric labels and audio-only downloads keep the tool's own best-pick.
  for (const label of ["best", "", null, undefined, "abc", "50", "99p"]) {
    assert.deepEqual(buildHlsSelectArgs(label as string, "video"), ["--auto-select"], String(label));
  }
  assert.deepEqual(buildHlsSelectArgs("1080p", "audio"), ["--auto-select"]);
});

test("buildNm3u8dlArgs emits the chosen selector", () => {
  const args = buildNm3u8dlArgs({ url: "https://x.test/a.m3u8", outputDir: "/tmp", saveName: "v", qualityLabel: "720p" });
  assert.equal(args.includes("--auto-select"), false);
  assert.deepEqual(args.slice(args.indexOf("--select-video"), args.indexOf("--select-video") + 2), ["--select-video", "res=720*:for=best"]);

  const auto = buildNm3u8dlArgs({ url: "https://x.test/a.m3u8", outputDir: "/tmp", saveName: "v", autoSelect: true });
  assert.equal(auto.includes("--auto-select"), true);
});

test("header block parser ignores junk and blocks CRLF injection", () => {
  const headers = parseHeaderLines(
    "Referer: https://site.test/w\r\nUser-Agent: Mozilla/5.0\n# comment\nbad line\nX-Bad: a\tb\n: nope\nX-Ok: ok",
  );
  assert.deepEqual(headers, { Referer: "https://site.test/w", "User-Agent": "Mozilla/5.0", "X-Ok": "ok" });
  assert.deepEqual(parseHeaderLines(null), {});
  const injected = parseHeaderLines("Referer: ok\nX-Evil: value\rInjected: 1");
  assert.equal(injected.Referer, "ok");
  assert.equal("Injected" in injected, false);
});

test("cookies.txt is filtered by host and turned into a Cookie header", () => {
  const cookies = [
    "# Netscape HTTP Cookie File",
    "#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsession\tabc123",
    ".example.com\tTRUE\t/\tFALSE\t0\tpref\tdark",
    "other.test\tFALSE\t/\tFALSE\t0\tnope\t1",
  ].join("\n");

  assert.equal(
    buildCookieHeader(cookies, "https://cdn.example.com/master.m3u8"),
    "session=abc123; pref=dark",
  );
  assert.equal(buildCookieHeader(cookies, "https://example.com/a.m3u8"), "session=abc123; pref=dark");
  assert.equal(buildCookieHeader(cookies, "https://notexample.com/a.m3u8"), null);
  assert.equal(buildCookieHeader("", "https://example.com/a.m3u8"), null);
  assert.equal(buildCookieHeader(cookies, "not a url"), null);

  // A tampered file cannot smuggle extra headers.
  const tampered = "example.com\tFALSE\t/\tFALSE\t0\tx\ty\rZ: 1";
  assert.equal(buildCookieHeader(tampered, "https://example.com/a.m3u8"), null);
});

test("YouTube probe answers are classified honestly", async () => {
  const { classifyYoutubeProbe } = await import("../src/lib/youtube-health");
  assert.equal(classifyYoutubeProbe({ code: 0, stderr: "", stdout: "{}" }).state, "ok");
  assert.equal(
    classifyYoutubeProbe({ code: 1, stderr: "ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies", stdout: "" }).state,
    "bot-check",
  );
  assert.equal(classifyYoutubeProbe({ code: 1, stderr: "ERROR: HTTP Error 429: Too Many Requests", stdout: "" }).state, "rate-limit");
  assert.equal(classifyYoutubeProbe({ code: 1, stderr: "ERROR: Unable to download webpage: getaddrinfo ENOTFOUND", stdout: "" }).state, "network");
  assert.equal(classifyYoutubeProbe({ code: 1, stderr: "ERROR: something else", stdout: "" }).state, "unknown");
  // Every non-ok state must propose an action, never a dead end.
  for (const stderr of ["Sign in to confirm you're not a bot", "HTTP Error 429", "getaddrinfo", "weird"]) {
    const health = classifyYoutubeProbe({ code: 1, stderr, stdout: "" });
    assert.equal(typeof health.action, "string");
  }
});
