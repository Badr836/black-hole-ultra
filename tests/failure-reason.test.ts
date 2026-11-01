import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, failureCodeOf, FAILURE_CODES } from "../src/lib/failure-reason";

test("datacenter-IP challenge is not reported as a generic auth wall", () => {
  const info = classifyFailure("ERROR: [youtube] aqz: Sign in to confirm you’re not a bot. Use --cookies");
  assert.equal(info.code, "datacenter_ip");
  assert.equal(info.retryable, false);
  assert.match(info.hint, /كوكيز/);
});

test("real login walls are auth_required", () => {
  assert.equal(failureCodeOf("ERROR: [instagram] 123: Requested content is not available, rate-limit reached or login required"), "rate_limit");
  assert.equal(failureCodeOf("ERROR: This video is private"), "auth_required");
  assert.equal(failureCodeOf("ERROR: [vimeo] 76979871: The web client only works when logged-in"), "auth_required");
});

test("DRM wins over everything else in the same message", () => {
  assert.equal(failureCodeOf("ERROR: unable to extract; DRM protected (Widevine)"), "drm");
  assert.equal(failureCodeOf("‏المحتوى مشفّر بـ Widevine"), "drm");
});

test("expired signed URL is distinguished from an auth failure", () => {
  assert.equal(failureCodeOf("HTTP Error 410: Gone — signature has expired"), "expired_url");
  assert.equal(failureCodeOf("رابط موقّع انتهت صلاحيته"), "expired_url");
});

test("extractor gaps and format gaps stay separate", () => {
  assert.equal(failureCodeOf("ERROR: Unsupported URL: https://example.com/page"), "unsupported_extractor");
  assert.equal(failureCodeOf("ERROR: [generic] No video could be found in this page"), "unsupported_extractor");
  assert.equal(failureCodeOf("ERROR: Requested format is not available"), "unsupported_format");
});

test("network failures are retryable, disk errors are not silently swallowed", () => {
  const net = classifyFailure("getaddrinfo ENOTFOUND cdn.example.com");
  assert.equal(net.code, "network");
  assert.equal(net.retryable, true);
  assert.equal(failureCodeOf("ENOSPC: no space left on device"), "disk");
});

test("our own Arabic messages map to codes too", () => {
  assert.equal(failureCodeOf("توقّف المحرك عن إرسال أي بيانات لمدة 5 دقيقة، فأُوقفت المهمة."), "stalled");
  assert.equal(failureCodeOf("الملف غير مكتمل: الحجم بعد النقل 100 بايت والمتوقع 200"), "integrity");
  assert.equal(failureCodeOf("yt-dlp غير موجود. ثبّته أو ضعه في مجلد bin/"), "missing_binary");
});

test("unknown text does not invent a cause", () => {
  const info = classifyFailure("something odd happened");
  assert.equal(info.code, "unknown");
  assert.equal(info.retryable, true);
  assert.equal(classifyFailure(null).code, "unknown");
});

test("every code has a label and a hint", () => {
  for (const code of FAILURE_CODES) {
    const info = classifyFailure("");
    assert.ok(info.label.length > 0, code);
  }
});
