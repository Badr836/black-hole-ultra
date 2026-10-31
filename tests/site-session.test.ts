import test from "node:test";
import assert from "node:assert/strict";
import { buildCookieHeader, buildHlsSelectArgs, inspectHlsManifest, parseHlsAttributes } from "../src/lib/hls";
import { buildHeaderCandidates, describeProbe, originOf, pickWorkingHeaders } from "../src/lib/site-session";

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Arabic",LANGUAGE="ar",DEFAULT=YES,CHANNELS="2",URI="ar.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=NO,CHANNELS="2",URI="en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="hvc1.1.6",VIDEO-RANGE=PQ,FRAME-RATE=50.000
1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.4d401f",VIDEO-RANGE=SDR
720.m3u8
`;

test("manifest attributes parse quoted and bare values", () => {
  const attrs = parseHlsAttributes('#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="hvc1.1.6"');
  assert.equal(attrs.BANDWIDTH, "5200000");
  assert.equal(attrs.RESOLUTION, "1920x1080");
  assert.equal(attrs.CODECS, "hvc1.1.6");
});

test("inspectHlsManifest reads variants, ranges, codecs and audio languages", () => {
  const info = inspectHlsManifest(MASTER, "https://cdn.example.com/live/master.m3u8");
  assert.equal(info.isMaster, true);
  assert.equal(info.variants.length, 2);
  assert.deepEqual(info.variants[0], {
    url: "https://cdn.example.com/live/1080.m3u8",
    width: 1920,
    height: 1080,
    bandwidth: 5200000,
    codecs: "hvc1.1.6",
    range: "PQ",
    frameRate: 50,
  });
  assert.equal(info.variants[1].range, "SDR");
  assert.deepEqual(
    info.audio.map((track) => [track.language, track.name, track.isDefault]),
    [
      ["ar", "Arabic", true],
      ["en", "English", false],
    ],
  );
  assert.equal(info.audio[0].uri, "https://cdn.example.com/live/ar.m3u8");
  assert.equal(info.drm, false);
});

test("inspectHlsManifest refuses DRM manifests and counts segments", () => {
  const drm = inspectHlsManifest(
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\nseg1.ts\n',
    "https://x.test/a.m3u8",
  );
  assert.equal(drm.drm, true);
  assert.equal(drm.segmentCount, 1);
  const widevine = inspectHlsManifest(
    '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="data:text/plain;base64,AAAA"\n',
    "https://x.test/a.m3u8",
  );
  assert.equal(widevine.drm, true);
  // AES-128 is not DRM (a normal encrypted HLS stream) and must not be flagged.
  assert.equal(inspectHlsManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n', "https://x.test/a.m3u8").drm, false);
});

test("selectors cover height, language, range and codecs", () => {
  assert.deepEqual(buildHlsSelectArgs({ qualityLabel: "720", audioLang: "ar" }), [
    "--select-video",
    "res=720*:for=best",
    "--select-audio",
    "lang=ar:for=best",
  ]);
  assert.deepEqual(buildHlsSelectArgs({ qualityLabel: "1080", videoRange: "hdr", codecs: "hvc1", audioLang: "Arabic" }), [
    "--select-video",
    "res=1080*:range=HDR:codecs=hvc1:for=best",
    "--select-audio",
    "lang=Arabic:for=best",
  ]);
  assert.deepEqual(buildHlsSelectArgs({ kind: "audio", audioLang: "en" }), ["--select-audio", "lang=en:for=best"]);
  assert.deepEqual(buildHlsSelectArgs({ kind: "audio" }), ["--auto-select"]);
  // Junk is dropped rather than passed to the tool as a regex.
  // Every filter is junk → nothing to filter by, so let the tool choose.
  assert.deepEqual(buildHlsSelectArgs({ audioLang: "ar.*", videoRange: "8bit", codecs: "avc1|x" }), ["--auto-select"]);
  // Partial junk keeps the valid part.
  assert.deepEqual(buildHlsSelectArgs({ qualityLabel: "720", audioLang: "ar.*" }), ["--select-video", "res=720*:for=best", "--select-audio", "for=best"]);
});

test("header candidates are ordered user → page → origin and deduplicated", () => {
  const candidates = buildHeaderCandidates({
    userHeaders: { Referer: "https://manual.example/" },
    pageUrl: "https://site.example/watch/1",
    manifestUrl: "https://cdn.example/hls/master.m3u8",
  });
  assert.deepEqual(candidates.map((candidate) => candidate.label), ["user", "page", "origin"]);
  assert.deepEqual(candidates[1].headers, { Referer: "https://site.example/watch/1", Origin: "https://site.example" });
  assert.deepEqual(candidates[2].headers, { Referer: "https://cdn.example/", Origin: "https://cdn.example" });

  // No duplicates when the page *is* the manifest origin.
  const same = buildHeaderCandidates({ pageUrl: "https://cdn.example/page", manifestUrl: "https://cdn.example/hls/master.m3u8" });
  assert.equal(same.length, 1);

  // Auto can be switched off: only the user's headers survive.
  const manual = buildHeaderCandidates({
    userHeaders: { Referer: "x" },
    pageUrl: "https://site.example/",
    manifestUrl: "https://cdn.example/a.m3u8",
    auto: false,
  });
  assert.deepEqual(manual.map((candidate) => candidate.label), ["user"]);

  // Header injection is filtered out before it can reach the tool.
  const injected = buildHeaderCandidates({ userHeaders: { Referer: "ok\r\nX-Evil: 1" }, manifestUrl: "https://cdn.example/a.m3u8", auto: false });
  assert.deepEqual(injected, []);
});

test("pickWorkingHeaders stops at the first 2xx and reports every attempt", async () => {
  const candidates = buildHeaderCandidates({
    userHeaders: { Referer: "https://manual.example/" },
    pageUrl: "https://site.example/watch/1",
    manifestUrl: "https://cdn.example/hls/master.m3u8",
  });
  const calls: string[] = [];
  const fakeProbe = async (_url: string, headers: Record<string, string>) => {
    calls.push(headers.Referer);
    if (headers.Referer === "https://site.example/watch/1") return 200;
    return 403;
  };
  const result = await pickWorkingHeaders(candidates, "https://cdn.example/hls/master.m3u8", fakeProbe);
  assert.equal(result.chosen?.label, "page");
  assert.deepEqual(result.attempts.map((attempt) => attempt.status), [403, 200]);
  assert.equal(calls.length, 2);
  assert.match(describeProbe(result), /اختير: page/);

  // Nothing answers 2xx → the first candidate is returned so the engine's own
  // error message stays in charge (no silent "no headers" downgrade).
  const failing = await pickWorkingHeaders(candidates, "https://cdn.example/x.m3u8", async () => 403);
  assert.equal(failing.chosen?.label, "user");
  assert.equal(failing.attempts.length, 3);

  // A network error on one candidate must not abort the chain.
  const flaky = await pickWorkingHeaders(
    candidates,
    "https://cdn.example/x.m3u8",
    async (_url, headers) => {
      if (headers.Referer === "https://manual.example/") throw new Error("ECONNRESET");
      return 200;
    },
  );
  assert.equal(flaky.chosen?.label, "page");
  assert.equal(flaky.attempts[0].status, null);
});

test("originOf only accepts http(s) URLs", () => {
  assert.equal(originOf("https://a.test/x/y.m3u8"), "https://a.test");
  assert.equal(originOf("ftp://a.test/x"), null);
  assert.equal(originOf("not a url"), null);
});

test("cookie header still respects host filtering (regression)", () => {
  const cookies = "cdn.example\tFALSE\t/\tFALSE\t0\tsession\tabc\nother.test\tFALSE\t/\tFALSE\t0\tnope\t1\n";
  assert.equal(buildCookieHeader(cookies, "https://cdn.example/a.m3u8"), "session=abc");
  assert.equal(buildCookieHeader(cookies, "https://other.test/a.m3u8"), "nope=1");
  assert.equal(buildCookieHeader(cookies, "https://third.test/a.m3u8"), null);
});

test("audio language resolution matches the manifest spelling case-insensitively", async () => {
  const { resolveAudioLanguage } = await import("../src/lib/hls");
  const manifest = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Arabic",LANGUAGE="Arabic",DEFAULT=YES,URI="ar.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en-US",DEFAULT=NO,URI="en.m3u8"
`;
  assert.equal(resolveAudioLanguage(manifest, "arabic"), "Arabic");
  assert.equal(resolveAudioLanguage(manifest, "en"), "en-US"); // prefix match
  assert.equal(resolveAudioLanguage(manifest, "ar-SA"), "ar-SA"); // unknown → kept (tool decides)
  assert.equal(resolveAudioLanguage(manifest, null), null);
  assert.equal(resolveAudioLanguage(manifest, "ar.*"), null);
});

test("mux-after-done is only added when a container is requested", async () => {
  const { buildNm3u8dlArgs } = await import("../src/lib/hls");
  const base = { url: "https://x.test/a.m3u8", outputDir: "/tmp", saveName: "v" };
  assert.equal(buildNm3u8dlArgs(base).includes("--mux-after-done"), false);
  const muxed = buildNm3u8dlArgs({ ...base, muxFormat: "mp4" });
  const index = muxed.indexOf("--mux-after-done");
  assert.notEqual(index, -1);
  assert.equal(muxed[index + 1], "format=mp4:skip_sub=true");
  const withSubs = buildNm3u8dlArgs({ ...base, muxFormat: "mkv", subtitles: true });
  assert.equal(withSubs[withSubs.indexOf("--mux-after-done") + 1], "format=mkv:skip_sub=false");
});
