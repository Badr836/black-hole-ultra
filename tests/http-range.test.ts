import test from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../src/lib/http-range";

test("no Range header means the whole file", () => {
  assert.deepEqual(parseRange(null, 1000), { kind: "full" });
  assert.deepEqual(parseRange("", 1000), { kind: "full" });
});

test("explicit range is returned verbatim", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { kind: "partial", start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", 1000), { kind: "partial", start: 100, end: 999 });
});

test("end beyond EOF is clamped instead of crashing the stream", () => {
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { kind: "partial", start: 900, end: 999 });
});

test("suffix range returns the last N bytes", () => {
  assert.deepEqual(parseRange("bytes=-200", 1000), { kind: "partial", start: 800, end: 999 });
});

test("REGRESSION: non-numeric range used to become NaN and throw 500", () => {
  const result = parseRange("bytes=abc-def", 1000);
  assert.equal(result.kind, "invalid");
});

test("REGRESSION: reversed range used to reach createReadStream", () => {
  const result = parseRange("bytes=500-100", 1000);
  assert.equal(result.kind, "invalid");
});

test("start at/after EOF is unsatisfiable", () => {
  assert.equal(parseRange("bytes=1000-", 1000).kind, "invalid");
  assert.equal(parseRange("bytes=9999-10000", 1000).kind, "invalid");
});

test("multi-range and garbage headers are rejected, not guessed", () => {
  assert.equal(parseRange("bytes=0-10,20-30", 1000).kind, "invalid");
  assert.equal(parseRange("items=0-10", 1000).kind, "invalid");
  assert.equal(parseRange("bytes=", 1000).kind, "invalid");
});

test("empty file never yields a partial range", () => {
  assert.equal(parseRange("bytes=0-10", 0).kind, "invalid");
});
