import test from "node:test";
import assert from "node:assert/strict";
import {
  galleryHostLabel,
  isRateLimitMessage,
  platformHint,
  routeProvider,
  shouldTryFallback,
} from "../src/lib/providers";

const both = { ytdlp: true, gallerydl: true };
const onlyYt = { ytdlp: true, gallerydl: false };
const onlyGd = { ytdlp: false, gallerydl: true };

test("gallery-style platforms route to gallery-dl", () => {
  for (const url of [
    "https://www.instagram.com/p/CqLMqFqJ8QK/",
    "https://www.instagram.com/reel/abc/",
    "https://x.com/user/status/123",
    "https://twitter.com/user/status/123",
    "https://www.pinterest.com/pin/123/",
    "https://www.reddit.com/r/aww/comments/abc/title/",
  ]) {
    assert.equal(routeProvider(url, both).provider, "gallerydl", url);
  }
});

test("video platforms keep using yt-dlp", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "https://www.facebook.com/watch/?v=1",
    "https://vimeo.com/1",
    "https://soundcloud.com/a/b",
    "https://example.com/file.mp4",
  ]) {
    assert.equal(routeProvider(url, both).provider, "ytdlp", url);
  }
});

test("missing gallery-dl degrades to yt-dlp with an explicit reason", () => {
  const route = routeProvider("https://www.instagram.com/p/x/", onlyYt);
  assert.equal(route.provider, "ytdlp");
  assert.match(route.reason, /gallery-dl غير مثبّت/);
  assert.equal(route.fallback, null);
});

test("missing yt-dlp still leaves gallery-dl usable", () => {
  assert.equal(routeProvider("https://example.com/file.mp4", onlyGd).provider, "gallerydl");
});

test("an explicit user preference overrides automatic routing", () => {
  assert.equal(routeProvider("https://www.instagram.com/p/x/", both, "ytdlp").provider, "ytdlp");
  assert.equal(routeProvider("https://youtu.be/abc", both, "gallerydl").provider, "gallerydl");
});

test("fallback is offered whenever both engines exist", () => {
  assert.equal(routeProvider("https://youtu.be/abc", both).fallback, "gallerydl");
  assert.equal(routeProvider("https://x.com/a/status/1", both).fallback, "ytdlp");
});

test("engine-gap errors trigger the fallback, auth errors do not", () => {
  assert.equal(shouldTryFallback("No video could be found in this tweet"), true);
  assert.equal(shouldTryFallback("Unsupported URL: https://x.com/nasa"), true);
  assert.equal(shouldTryFallback("Instagram sent an empty media response"), true);
  assert.equal(shouldTryFallback("Unable to extract data"), true);
  // Requiring a login is not an engine gap: falling back would just fail again.
  assert.equal(shouldTryFallback("Account authentication is required"), false);
  assert.equal(shouldTryFallback("HTTP Error 429: Too Many Requests"), false);
  assert.equal(shouldTryFallback("Sign in to confirm your age"), false);
});

test("rate limiting is detected from both engines' output", () => {
  // gallery-dl: "[instagram][info] Waiting for 1 minutes until … (429 Too Many Requests)"
  assert.equal(isRateLimitMessage("[instagram][info] Waiting for 1 minutes until 19:31:19 (429 Too Many Requests)"), true);
  // yt-dlp: "ERROR: unable to download webpage: HTTP Error 429: Too Many Requests"
  assert.equal(isRateLimitMessage("ERROR: HTTP Error 429: Too Many Requests"), true);
  assert.equal(isRateLimitMessage("[download] 42.5% of 10MiB at 2.1MiB/s"), false);
  assert.equal(isRateLimitMessage(""), false);
});

test("platform hints explain the only legitimate solution (cookies)", () => {
  assert.match(String(platformHint("https://www.instagram.com/p/x/")), /كوكيز/);
  assert.match(String(platformHint("https://www.reddit.com/r/a/comments/b/c/")), /كوكيز/);
  assert.equal(platformHint("https://youtu.be/abc"), null);
});

test("host label detection is host-based, not substring-based", () => {
  assert.equal(galleryHostLabel("https://notinstagram.com/p/1"), null);
  assert.equal(galleryHostLabel("https://www.instagram.com.evil.com/p/1"), null);
  assert.match(String(galleryHostLabel("https://www.instagram.com/p/1")), /Instagram/);
});
