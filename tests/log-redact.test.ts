import test from "node:test";
import assert from "node:assert/strict";
import { redactLog, extractYtDlpError, extractFfmpegError } from "../src/lib/log-redact";

test("cookie flags are redacted", () => {
  const out = redactLog('yt-dlp --cookies /home/me/cookies.txt --cookies-from-browser chrome');
  assert.ok(!out.includes("/home/me/cookies.txt"));
  assert.ok(!out.includes("chrome"));
  assert.ok(out.includes("[REDACTED]"));
});

test("REGRESSION: injected --add-headers values are redacted too", () => {
  const out = redactLog('--add-headers "Authorization:Bearer SECRET-TOKEN" --add-headers Accept-Language:ar');
  assert.ok(!out.includes("SECRET-TOKEN"));
});

test("signed URL query strings are stripped", () => {
  const out = redactLog("downloading https://cdn.example.com/v.mp4?token=abcdef&expires=123");
  assert.ok(!out.includes("abcdef"));
  assert.ok(out.includes("https://cdn.example.com/v.mp4?[REDACTED]"));
});

test("inline Authorization/Cookie header dumps are redacted", () => {
  const out = redactLog("Authorization: Bearer abc.def\nCookie: SID=xyz\nx-blackhole-token: sekret");
  assert.ok(!out.includes("abc.def"));
  assert.ok(!out.includes("SID=xyz"));
  assert.ok(!out.includes("sekret"));
});

test("log is capped so it cannot grow without bound", () => {
  assert.ok(redactLog("x".repeat(50_000)).length <= 12_000);
});

test("yt-dlp and ffmpeg error extraction pick the useful line", () => {
  assert.equal(
    extractYtDlpError("junk\nERROR: Video unavailable\nmore junk"),
    "Video unavailable",
  );
  assert.match(extractFfmpegError("frame=1\nError opening input\nframe=2"), /Error opening input/);
  assert.equal(extractYtDlpError(""), "");
});
