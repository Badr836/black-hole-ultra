import test from "node:test";
import assert from "node:assert/strict";
import {
  friendlyDownloadError,
  impersonationCaps,
  parseImpersonateTargets,
  profileForRetry,
  resetImpersonationCache,
  siteOptions,
} from "../src/lib/site-options";

const NO_CURL_CFFI = `[info] Available impersonate targets
Client    OS    Source
----------------------------------
Tor       -     curl_cffi>=0.11 (unavailable)`;

const WITH_CURL_CFFI = `[info] Available impersonate targets
Client      OS       Source
--------------------------------------
Chrome      macos    curl_cffi>=0.5.10
Safari      -        curl_cffi>=0.10.0
Chrome      android  curl_cffi>=0.5.10`;

test("REGRESSION: targets marked unavailable are not treated as available", () => {
  // yt-dlp exits 0 in this case, so the old exit-code check wrongly enabled --impersonate.
  assert.deepEqual(parseImpersonateTargets(NO_CURL_CFFI), []);
});

test("available targets are parsed from real output", () => {
  // Duplicate clients collapse — one entry per client is enough to rotate on.
  assert.deepEqual(parseImpersonateTargets(WITH_CURL_CFFI), ["Chrome", "Safari"]);
});

test("capability probe is cached and reports unsupported without curl_cffi", async () => {
  resetImpersonationCache();
  let calls = 0;
  const caps = await impersonationCaps(async () => {
    calls += 1;
    return NO_CURL_CFFI;
  });
  assert.equal(caps.supported, false);
  await impersonationCaps(async () => {
    calls += 1;
    return WITH_CURL_CFFI;
  });
  assert.equal(calls, 1, "second call must hit the cache");
});

test("no --impersonate flag is emitted when the build cannot impersonate", () => {
  const args = siteOptions("https://www.tiktok.com/@x/video/1", 0, { impersonate: false });
  assert.ok(!args.includes("--impersonate"));
  assert.ok(args.includes("--add-headers"));
});

test("impersonate flag is emitted when support exists, rotating profiles per retry", () => {
  const first = siteOptions("https://www.tiktok.com/@x/video/1", 0, { impersonate: true, availableProfiles: ["Chrome"] });
  assert.equal(first[0], "--impersonate");
  assert.equal(first[1], "chrome");
});

test("non-TikTok URLs get no compatibility flags at all", () => {
  assert.deepEqual(siteOptions("https://example.com/a", 0, { impersonate: true }), []);
});

test("profile fallback never leaves the list empty", () => {
  assert.equal(profileForRetry(9, ["Chrome"]), "chrome");
  assert.equal(profileForRetry(9, []), null);
});

test("login-walled platforms get actionable cookie advice, not raw yt-dlp text", () => {
  assert.match(
    friendlyDownloadError("Instagram sent an empty media response", "https://www.instagram.com/p/x/"),
    /كوكيز/,
  );
  assert.match(friendlyDownloadError("Account authentication is required", "https://www.reddit.com/r/x/"), /تسجيل دخول/);
  assert.match(friendlyDownloadError("The web client only works when logged-in", "https://vimeo.com/1"), /جلسة مسجّلة/);
  assert.match(friendlyDownloadError("Unsupported URL: https://x.com/nasa", "https://x.com/nasa"), /لا يدعم هذا الموقع/);
  assert.match(friendlyDownloadError("This video is protected by DRM", "https://example.com/v"), /DRM/);
});

test("friendly errors explain impersonation and format problems", () => {
  assert.match(
    friendlyDownloadError("Impersonate target not available", "https://www.tiktok.com/x"),
    /curl-cffi/,
  );
  assert.match(
    friendlyDownloadError("Requested format is not available", "https://example.com/x"),
    /أعد التحليل/,
  );
  assert.match(friendlyDownloadError("Video unavailable", "https://example.com/x"), /غير متاح/);
});

test("YouTube 403 media refusal becomes actionable Arabic guidance", () => {
  const msg = friendlyDownloadError(
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    "https://www.youtube.com/watch?v=abc",
  );
  assert.match(msg, /403/);
  assert.match(msg, /كوكيز/);
  // the same error on another host must not claim it is YouTube
  const other = friendlyDownloadError(
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    "https://vimeo.com/123",
  );
  assert.equal(other, "unable to download video data: HTTP Error 403: Forbidden");
});
