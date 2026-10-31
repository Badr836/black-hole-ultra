import test from "node:test";
import assert from "node:assert/strict";
import {
  canRetryIncomplete,
  computeMissingEntries,
  indicesToSpec,
  MAX_INCOMPLETE_RETRIES,
  parseFileMarker,
  parsePlaylistItemMarker,
  playlistSpecToIndices,
  playlistTotalFromOutput,
  retrySpecFor,
  incompleteSummary,
} from "../src/lib/playlist";

test("playlist markers are parsed, junk is ignored", () => {
  assert.deepEqual(parsePlaylistItemMarker("BHITEM:7|dQw4w9WgXcQ"), { index: 7, id: "dQw4w9WgXcQ" });
  assert.deepEqual(parsePlaylistItemMarker("BHITEM:12|"), { index: 12, id: "" });
  assert.equal(parsePlaylistItemMarker("/videos/a.mp4"), null);
  assert.equal(parsePlaylistItemMarker("BHITEM:abc|def"), null);

  assert.deepEqual(parseFileMarker("BHFILE:dQw4w9WgXcQ|/videos/a.mp4"), {
    id: "dQw4w9WgXcQ",
    path: "/videos/a.mp4",
  });
  assert.deepEqual(parseFileMarker("BHFILE:|/videos/a.mp4"), { id: "", path: "/videos/a.mp4" });
  assert.equal(parseFileMarker("BHFILE:id|"), null);
});

test("spec <-> indices round trips", () => {
  assert.deepEqual(playlistSpecToIndices("1-3,7,9-10"), [1, 2, 3, 7, 9, 10]);
  assert.deepEqual(playlistSpecToIndices("5"), [5]);
  assert.deepEqual(playlistSpecToIndices(null), []);
  assert.equal(indicesToSpec([3, 4, 5, 9]), "3-5,9");
  assert.equal(indicesToSpec([9, 3, 5, 4, 5]), "3-5,9");
  assert.equal(indicesToSpec([]), "");
});

test("total comes from the engine output only", () => {
  assert.equal(playlistTotalFromOutput("[download] Downloading item 4 of 12"), 12);
  assert.equal(playlistTotalFromOutput("nothing"), null);
});

test("a complete playlist reports no missing entries", () => {
  const items = [1, 2, 3].map((index) => ({ index, id: `id${index}` }));
  const missing = computeMissingEntries({
    requested: "1-3",
    total: 3,
    items,
    producedIds: ["id1", "id2", "id3"],
    log: "",
  });
  assert.deepEqual(missing, []);
});

test("an unavailable entry is reported with its reason", () => {
  const missing = computeMissingEntries({
    requested: "1-3",
    total: 3,
    items: [
      { index: 1, id: "id1" },
      { index: 2, id: "dead" },
      { index: 3, id: "id3" },
    ],
    producedIds: ["id1", "id3"],
    log: "ERROR: [youtube] dead: Private video. Sign in if you've been granted access",
  });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].index, 2);
  assert.equal(missing[0].id, "dead");
  assert.match(missing[0].reason, /Private video/);
  assert.equal(retrySpecFor(missing), "2");
});

test("an index that never reached the engine is still counted as missing", () => {
  const missing = computeMissingEntries({
    requested: "1-10,999",
    total: 10,
    items: Array.from({ length: 10 }, (_, i) => ({ index: i + 1, id: `id${i + 1}` })),
    producedIds: Array.from({ length: 10 }, (_, i) => `id${i + 1}`),
    log: "",
  });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].index, 999);
  assert.equal(missing[0].id, "");
});

test("without a spec the expected range comes from 'of N'", () => {
  const missing = computeMissingEntries({
    requested: null,
    total: 4,
    items: [
      { index: 1, id: "a" },
      { index: 2, id: "b" },
      { index: 3, id: "c" },
      { index: 4, id: "d" },
    ],
    producedIds: ["a", "b", "c"],
    log: "ERROR: [youtube] d: Video unavailable",
  });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].index, 4);
  assert.match(missing[0].reason, /Video unavailable/);
});

test("retry spec keeps only the gaps (no re-download of finished items)", () => {
  const missing = [
    { index: 2, id: "b", reason: "x" },
    { index: 5, id: "e", reason: "x" },
    { index: 6, id: "f", reason: "x" },
  ];
  assert.equal(retrySpecFor(missing), "2,5-6");
});

test("retry is blocked when nothing is missing or the cap is reached", () => {
  assert.equal(canRetryIncomplete(null).ok, false);
  assert.equal(canRetryIncomplete({ missingItems: [] }).ok, false);
  assert.equal(canRetryIncomplete({ missingItems: [{ index: 2, id: "", reason: "" }] }).ok, true);
  const capped = canRetryIncomplete({
    missingItems: [{ index: 2, id: "", reason: "" }],
    incompleteRetry: MAX_INCOMPLETE_RETRIES,
  });
  assert.equal(capped.ok, false);
  assert.match(String(capped.reason), /محذوف أو خاص/);
});

test("summary states produced/expected and names the gaps", () => {
  const note = incompleteSummary(
    [
      { index: 2, id: "b", reason: "" },
      { index: 5, id: "e", reason: "" },
    ],
    10,
  );
  assert.match(note, /8 من 10/);
  assert.match(note, /#2/);
  assert.match(note, /إعادة الناقص/);
});
