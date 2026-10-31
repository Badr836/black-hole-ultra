import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFormats, pickThumbnail, playlistEntries, type RawFormat } from "../src/lib/analyzer-normalize";

const youtubeFormats: RawFormat[] = [
  { format_id: "137", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, fps: 30, filesize: 100 },
  { format_id: "248", ext: "webm", vcodec: "vp9", acodec: "none", height: 1080, fps: 30, filesize: 90 },
  { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 128, filesize: 5 },
  { format_id: "18", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 360, fps: 30, filesize: 20 },
  { format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none", height: 90 },
];

test("coded streams are split into video and audio options", () => {
  const { videoOptions, audioOptions } = normalizeFormats(youtubeFormats);
  assert.deepEqual(videoOptions.map((v) => v.formatId), ["137", "248", "18"]);
  assert.deepEqual(audioOptions.map((a) => a.formatId), ["140"]);
  assert.equal(audioOptions[0].label.includes("128"), true);
});

test("storyboard/mhtml formats are ignored", () => {
  const { videoOptions, directOptions } = normalizeFormats(youtubeFormats);
  assert.ok(![...videoOptions, ...directOptions].some((v) => v.formatId === "sb0"));
});

test("progressive format is marked single (no audio merge needed)", () => {
  const { videoOptions } = normalizeFormats(youtubeFormats);
  const progressive = videoOptions.find((v) => v.formatId === "18");
  assert.equal(progressive?.single, true);
  assert.equal(progressive?.hasAudio, true);
});

test("REGRESSION: a plain direct media URL used to yield zero options", () => {
  // Real `yt-dlp -J https://download.samplelib.com/mp4/sample-5s.mp4` output shape.
  const direct: RawFormat[] = [
    { format_id: "mp4", ext: "mp4", vcodec: null, acodec: null, height: null, protocol: "https" },
  ];
  const { videoOptions, audioOptions, directOptions } = normalizeFormats(direct);
  assert.equal(videoOptions.length, 0);
  assert.equal(audioOptions.length, 0);
  assert.equal(directOptions.length, 1);
  assert.equal(directOptions[0].formatId, "mp4");
  assert.equal(directOptions[0].single, true);
  assert.match(directOptions[0].label, /ملف مباشر/);
});

test("audio-only direct files land in the direct bucket once", () => {
  const { directOptions } = normalizeFormats([
    { format_id: "a", ext: "mp3", vcodec: null, acodec: null },
    { format_id: "b", ext: "mp3", vcodec: null, acodec: null },
  ]);
  assert.equal(directOptions.length, 1);
});

test("empty input is handled", () => {
  assert.deepEqual(normalizeFormats(null), { videoOptions: [], audioOptions: [], directOptions: [] });
  assert.deepEqual(normalizeFormats([]), { videoOptions: [], audioOptions: [], directOptions: [] });
});

test("thumbnails prefer a valid https URL and ignore junk", () => {
  assert.equal(
    pickThumbnail({ thumbnail: null, thumbnails: [{ url: "javascript:alert(1)" }, { url: "https://x/y.jpg" }] }),
    "https://x/y.jpg",
  );
  assert.equal(pickThumbnail({ thumbnail: null }), null);
});

test("playlist entries keep original order and url", () => {
  const entries = playlistEntries({
    entries: [
      { id: "abc", title: "one" },
      { webpage_url: "https://example.com/two", title: "two" },
      {},
    ],
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, "one");
  assert.match(entries[0].url, /watch\?v=abc/);
  assert.equal(entries[1].url, "https://example.com/two");
});
