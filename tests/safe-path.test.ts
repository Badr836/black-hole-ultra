import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import {
  allowedRoots,
  isInside,
  isServableFile,
  resolveOutputDir,
  sanitizeFileNameTemplate,
} from "../src/lib/safe-path";

const root = mkdtempSync(path.join(os.tmpdir(), "bh-safepath-"));
mkdirSync(path.join(root, "out"), { recursive: true });
mkdirSync(path.join(root, "outside"), { recursive: true });
writeFileSync(path.join(root, "out", "video.mp4"), "x");
writeFileSync(path.join(root, "outside", "secret.txt"), "s");

test("a folder inside an allowed root is accepted and created", () => {
  const target = path.join(root, "out", "nested", "deeper");
  const result = resolveOutputDir(target, path.join(root, "out"), [root]);
  assert.equal(result.ok, true);
});

test("relative requests resolve against the fallback", () => {
  const result = resolveOutputDir("sub", path.join(root, "out"), [root]);
  assert.deepEqual(result, { ok: true, path: path.join(root, "out", "sub") });
});

test("a path outside every allowed root is refused", () => {
  const result = resolveOutputDir(path.join(root, "outside"), path.join(root, "out"), [path.join(root, "out")]);
  assert.equal(result.ok, false);
});

test("parent traversal cannot escape the root", () => {
  const result = resolveOutputDir(path.join(root, "out", "..", "outside"), path.join(root, "out"), [path.join(root, "out")]);
  assert.equal(result.ok, false);
});

test("NUL bytes in a path are rejected", () => {
  const result = resolveOutputDir(`${root}/out/a\0b`, path.join(root, "out"), [root]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /NUL/);
});

test("a symlink pointing outside the root is refused (realpath check)", () => {
  const link = path.join(root, "out", "escape");
  try {
    symlinkSync(path.join(root, "outside"), link, "dir");
  } catch {
    return; // platform without symlink permission
  }
  assert.equal(isInside(link, path.join(root, "out")), false);
});

test("file template cannot climb out of the output directory", () => {
  assert.equal(sanitizeFileNameTemplate("../../etc/passwd.%(ext)s"), "etc_passwd.%(ext)s");
  assert.equal(sanitizeFileNameTemplate("/abs/%(title)s.%(ext)s"), "abs_%(title)s.%(ext)s");
  assert.equal(sanitizeFileNameTemplate("..\\..\\%(title)s.%(ext)s"), "%(title)s.%(ext)s");
});

test("template keeps a sane default and gains an extension placeholder", () => {
  assert.equal(sanitizeFileNameTemplate(""), "%(title)s [%(id)s].%(ext)s");
  assert.equal(sanitizeFileNameTemplate("%(title)s"), "%(title)s.%(ext)s");
});

test("only files inside an allowed root are servable", () => {
  assert.equal(isServableFile(path.join(root, "out", "video.mp4"), [root]), true);
  assert.equal(isServableFile(path.join(root, "outside", "secret.txt"), [path.join(root, "out")]), false);
  assert.equal(isServableFile(null, [root]), false);
  assert.equal(isServableFile("/etc/passwd\0", [root]), false);
});

test("allowed roots always include the home directory and temp dir", () => {
  const roots = allowedRoots();
  assert.ok(roots.includes(path.resolve(os.homedir())));
  assert.ok(roots.includes(path.resolve(os.tmpdir())));
});
