import test from "node:test";
import assert from "node:assert/strict";
import { cookieCoverage, effectiveCookiesPath, parseCookieFile, validateCookieContent } from "../src/lib/cookies";

const FILE = `# Netscape HTTP Cookie File
.instagram.com\tTRUE\t/\tTRUE\t1790000000\tsessionid\tabc123
.instagram.com\tTRUE\t/\tTRUE\t1790000000\tds_user_id\t42
.reddit.com\tTRUE\t/\tFALSE\t1790000000\treddit_session\trs1
.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSID\ty1`;

test("Netscape cookie files are parsed, comments skipped", () => {
  const rows = parseCookieFile(FILE);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].domain, "instagram.com");
  assert.equal(rows[0].name, "sessionid");
});

test("malformed lines are ignored instead of throwing", () => {
  assert.deepEqual(parseCookieFile("garbage\n\n# comment\n.\t.\t."), []);
});

test("coverage maps cookies to platforms and detects real sessions", () => {
  const coverage = cookieCoverage(FILE);
  assert.equal(coverage.hasCookies, true);
  const instagram = coverage.platforms.find((p) => p.id === "instagram");
  assert.equal(instagram?.covered, true);
  assert.equal(coverage.platforms.find((p) => p.id === "reddit")?.covered, true);
  assert.equal(coverage.platforms.find((p) => p.id === "facebook")?.covered, false);
  assert.deepEqual(coverage.sessions, ["إنستغرام", "ريديت", "يوتيوب"]);
});

test("cookies without a session cookie are reported as not covered", () => {
  const coverage = cookieCoverage(".instagram.com\tTRUE\t/\tTRUE\t1\ttracking\t1");
  assert.equal(coverage.hasCookies, true);
  assert.equal(coverage.platforms.find((p) => p.id === "instagram")?.covered, false);
});

test("empty input is handled", () => {
  const coverage = cookieCoverage(null);
  assert.equal(coverage.hasCookies, false);
  assert.equal(coverage.count, 0);
});

test("a JSON export is rejected with a clear message (not silently accepted)", () => {
  const result = validateCookieContent('[{"name":"sessionid","value":"x"}]');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Netscape/);
});

test("a valid file passes validation with a count", () => {
  const result = validateCookieContent(FILE);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.count, 4);
});

test("an uploaded cookies file is used even when Settings never stored a path", () => {
  // An explicit choice always wins, so a user can point at a file elsewhere.
  assert.equal(effectiveCookiesPath("/srv/secret/my-cookies.txt"), "/srv/secret/my-cookies.txt");
  // Blank/whitespace means "not set": fall back to the default location, and to
  // null when nothing was uploaded (the tools must not be handed a dead path).
  assert.equal(effectiveCookiesPath("   "), effectiveCookiesPath(null));
  assert.equal(effectiveCookiesPath(null), effectiveCookiesPath(undefined));
});
