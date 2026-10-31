import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSelector,
  needsFfmpeg,
  normalizeContainer,
  sanitizeFormatId,
  sanitizePlaylistItems,
} from "../src/lib/format-selector";

test("audio selection maps to bestaudio", () => {
  assert.equal(buildSelector({ kind: "audio", quality: "best", container: "mp3" }).selector, "bestaudio/best");
});

test("video selection merges audio by default", () => {
  const { selector } = buildSelector({ kind: "video", quality: "1080", container: "mp4" });
  assert.match(selector, /\+bestaudio/);
  assert.match(selector, /height<=1080/);
});

test("progressive/direct formats do not force an audio merge", () => {
  const { selector } = buildSelector({
    kind: "video",
    quality: "id:hd",
    container: "mp4",
    mergeAudio: false,
  });
  assert.equal(selector, "hd");
  assert.equal(needsFfmpeg({ kind: "video", container: "mp4", selector }), false);
});

test("merging streams always needs ffmpeg", () => {
  assert.equal(needsFfmpeg({ kind: "video", container: "mp4", selector: "bv+ba" }), true);
  assert.equal(needsFfmpeg({ kind: "audio", container: "mp3", selector: "x" }), true);
  assert.equal(needsFfmpeg({ kind: "video", container: "mp4", selector: "x", subtitles: true }), true);
});

test("format ids are validated, so CLI-ish payloads are rejected", () => {
  assert.equal(sanitizeFormatId("137"), "137");
  assert.throws(() => sanitizeFormatId("137 --exec rm"));
  assert.throws(() => sanitizeFormatId(""));
});

test("containers are restricted to the supported sets", () => {
  assert.equal(normalizeContainer("video", "MP4"), "mp4");
  assert.equal(normalizeContainer("video", "exe"), "mp4");
  assert.equal(normalizeContainer("audio", "flac"), "flac");
  assert.equal(normalizeContainer("audio", "mkv"), "m4a");
});

test("playlist item specs accept yt-dlp syntax and reject anything else", () => {
  assert.equal(sanitizePlaylistItems("1-5,8,12-"), "1-5,8,12-");
  assert.equal(sanitizePlaylistItems(" 1 - 3 "), "1-3");
  assert.equal(sanitizePlaylistItems(""), null);
  assert.throws(() => sanitizePlaylistItems("1-5, --exec rm"));
  assert.throws(() => sanitizePlaylistItems("abc"));
});
