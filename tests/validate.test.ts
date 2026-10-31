import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultProbe, resolveToolPath, validateReadableFile, validateToolPath, type FsProbe } from "../src/lib/validate";
import { coerceSettingsPatch } from "../src/lib/settings";

const probe = (found = true, exec = true, file = true): FsProbe => ({
  exists: () => found,
  isFile: () => file,
  isExecutable: () => exec,
  isReadable: () => true,
});

test("empty path means auto-detect and is always accepted", () => {
  assert.deepEqual(validateToolPath("", probe(false, false, false)), { ok: true });
  assert.deepEqual(validateToolPath("   ", probe(false, false, false)), { ok: true });
});

test("missing path, directory and non-executable file are refused with a reason", () => {
  const missing = validateToolPath("/etc/passwd", probe(false));
  assert.equal(missing.ok, false);
  assert.match((missing as { reason: string }).reason, /غير موجود/);

  const dir = validateToolPath("/usr/bin", probe(true, true, false));
  assert.equal(dir.ok, false);
  assert.match((dir as { reason: string }).reason, /مجلد/);

  const noExec = validateToolPath("/etc/passwd", probe(true, false, true));
  assert.equal(noExec.ok, false);
  assert.match((noExec as { reason: string }).reason, /قابل للتنفيذ/);

  assert.deepEqual(validateToolPath("/usr/bin/ffmpeg", probe(true, true, true)), { ok: true });
});

test("readable-file check (cookies.txt) needs read permission, not exec", () => {
  const notReadable: FsProbe = { ...probe(), isReadable: () => false };
  assert.equal(validateReadableFile("/nope", probe(false)).ok, false);
  assert.equal(validateReadableFile("/root/cookies.txt", notReadable).ok, false);
  assert.deepEqual(validateReadableFile("", probe(false)), { ok: true });
});

test("real filesystem: /etc/passwd is not an executable tool, the real ffmpeg is", () => {
  assert.equal(validateToolPath("/etc/passwd").ok, false);
  assert.equal(validateReadableFile("/etc/passwd").ok, true);
});

test("settings PATCH rejects a bad ffmpegPath with an Arabic reason", () => {
  const result = coerceSettingsPatch({ ffmpegPath: "/etc/passwd" }, "/tmp", { probe: probe(true, false, true) });
  assert.equal(result.rejected.includes("ffmpegPath"), true);
  assert.equal("ffmpegPath" in result.patch, false);
  assert.match(result.reasons.ffmpegPath ?? "", /قابل للتنفيذ/);

  const good = coerceSettingsPatch({ ffmpegPath: "/usr/bin/ffmpeg" }, "/tmp", { probe: probe(true, true, true) });
  assert.deepEqual(good.rejected, []);
  assert.equal(good.patch.ffmpegPath, "/usr/bin/ffmpeg");
});

test("settings PATCH clamps the new concurrency cap instead of dropping it", () => {
  const high = coerceSettingsPatch({ maxConcurrent: 99 }, "/tmp", { probe: probe() });
  assert.equal(high.patch.maxConcurrent, 16);
  const low = coerceSettingsPatch({ maxConcurrent: 0 }, "/tmp", { probe: probe() });
  assert.equal(low.patch.maxConcurrent, 1);
  const off = coerceSettingsPatch({ maxConcurrent: "many" }, "/tmp", { probe: probe() });
  assert.equal(off.rejected.includes("maxConcurrent"), true);
});

test("HLS headers are trimmed and capped; cookies toggle is boolean-only", () => {
  const ok = coerceSettingsPatch(
    { hlsHeaders: "  Referer: https://example.com/watch\nCookie: a=1  ", hlsUseCookies: false },
    "/tmp",
    { probe: probe() },
  );
  assert.equal(ok.patch.hlsHeaders, "Referer: https://example.com/watch\nCookie: a=1");
  assert.equal(ok.patch.hlsUseCookies, false);

  const blank = coerceSettingsPatch({ hlsHeaders: "   " }, "/tmp", { probe: probe() });
  assert.equal(blank.patch.hlsHeaders, null);

  const long = coerceSettingsPatch({ hlsHeaders: "x".repeat(5_000) }, "/tmp", { probe: probe() });
  assert.equal(long.patch.hlsHeaders?.length, 2_000);

  const bad = coerceSettingsPatch({ hlsUseCookies: "yes" }, "/tmp", { probe: probe() });
  assert.equal(bad.rejected.includes("hlsUseCookies"), true);
});

test("cookiesPath is validated as a readable file on the real fs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bh-cookies-"));
  try {
    const file = path.join(dir, "cookies.txt");
    writeFileSync(file, "# Netscape HTTP Cookie File\n");
    chmodSync(file, 0o600);
    const ok = coerceSettingsPatch({ cookiesPath: file }, dir);
    assert.deepEqual(ok.rejected, []);
    assert.equal(ok.patch.cookiesPath, file);

    mkdirSync(path.join(dir, "adir"));
    const dirValue = coerceSettingsPatch({ cookiesPath: path.join(dir, "adir") }, dir);
    assert.equal(dirValue.rejected.includes("cookiesPath"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the UI sends the whole settings object: explicit nulls mean clear, not reject", () => {
  const result = coerceSettingsPatch(
    { ytdlpPath: null, ffmpegPath: null, gallerydlPath: null, jsRuntimePath: null, cookiesPath: null, hlsHeaders: null, cookiesFromBrowser: null },
    "/tmp",
    { probe: probe() },
  );
  assert.deepEqual(result.rejected, []);
  assert.equal(result.patch.ffmpegPath, null);
  assert.equal(result.patch.cookiesPath, null);
  assert.equal(result.patch.hlsHeaders, null);
});

test("Windows: no POSIX exec bit, so any existing file counts as a tool", () => {
  const win = defaultProbe("win32");
  const linux = defaultProbe("linux");
  // Same real file, two platforms: /etc/passwd is a file but not executable.
  assert.equal(win.isExecutable("/etc/passwd"), true);
  assert.equal(linux.isExecutable("/etc/passwd"), false);
  assert.deepEqual(validateToolPath("/etc/passwd", win), { ok: true });
  assert.equal(validateToolPath("/etc/passwd", linux).ok, false);
  // A directory is refused on both platforms.
  const notFile: FsProbe = { ...win, isFile: () => false };
  assert.equal(validateToolPath("/etc", notFile).ok, false);
});

test("a path written on the other OS is not mangled", () => {
  const winPath = String.raw`C:\ffmpeg\bin\ffmpeg.exe`;
  assert.equal(resolveToolPath(winPath), winPath);
  assert.equal(resolveToolPath("C:/ffmpeg/bin/ffmpeg.exe"), winPath);
  const unc = String.raw`\\server\share\yt-dlp.exe`;
  assert.equal(resolveToolPath(unc), unc);
  assert.equal(resolveToolPath("/usr/bin/ffmpeg"), "/usr/bin/ffmpeg");
  assert.equal(path.isAbsolute(resolveToolPath("relative/ffmpeg")), true);
});


test("settings keep a Windows tool path intact when validated on Linux", () => {
  // The file lives on the user's Windows machine, not here: only the *path
  // handling* is under test, so existence is stubbed.
  const win: FsProbe = { ...defaultProbe("win32"), exists: () => true, isFile: () => true };
  const result = coerceSettingsPatch({ ffmpegPath: String.raw`C:\ffmpeg\bin\ffmpeg.exe` }, "/tmp", { probe: win });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.patch.ffmpegPath, String.raw`C:\ffmpeg\bin\ffmpeg.exe`);
});
