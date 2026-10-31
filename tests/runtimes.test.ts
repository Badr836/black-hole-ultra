import test from "node:test";
import assert from "node:assert/strict";
import {
  candidatePaths,
  detectJsRuntimes,
  detectNameFromPath,
  isRuntimeSupported,
  jsRuntimeArgs,
  MIN_NODE_MAJOR,
  parseMajor,
  pickJsRuntime,
  rejectionReason,
  runtimeSummary,
  type JsRuntimeInfo,
} from "../src/lib/runtimes";

const runtime = (name: JsRuntimeInfo["name"], path: string, version: string | null): JsRuntimeInfo => ({
  name,
  path,
  version,
  supported: isRuntimeSupported(name, version),
  reason: rejectionReason(name, version),
});

test("version parsing", () => {
  assert.equal(parseMajor("v22.11.0"), 22);
  assert.equal(parseMajor("deno 2.9.8 (stable)"), 2);
  assert.equal(parseMajor("1.2.3"), 1);
  assert.equal(parseMajor(null), null);
  assert.equal(parseMajor("garbage"), null);
});

test(`Node below ${MIN_NODE_MAJOR} is rejected, Deno/Bun are accepted`, () => {
  assert.equal(isRuntimeSupported("node", "20.20.2"), false);
  assert.equal(isRuntimeSupported("node", "22.0.0"), true);
  assert.equal(isRuntimeSupported("deno", "2.9.8"), true);
  assert.equal(isRuntimeSupported("bun", "1.1.0"), true);
  assert.equal(isRuntimeSupported("deno", null), false);
  assert.match(String(rejectionReason("node", "20.20.2")), /22\+/);
});

test("preference order is deno → bun → node", () => {
  const list = [runtime("node", "/usr/bin/node", "22.1.0"), runtime("bun", "/usr/bin/bun", "1.1.0")];
  assert.equal(pickJsRuntime(list)?.name, "bun");
  assert.equal(pickJsRuntime([runtime("node", "/usr/bin/node", "22.1.0")])?.name, "node");
  // unsupported Node alone → no runtime at all (never pass a broken name)
  assert.equal(pickJsRuntime([runtime("node", "/usr/bin/node", "20.20.2")]), null);
  assert.equal(pickJsRuntime([]), null);
});

test("--js-runtimes uses a bare name on PATH and a path elsewhere", () => {
  const onPath = jsRuntimeArgs({ name: "deno", path: "/usr/local/bin/deno" }, null, {
    PATH: "/usr/local/bin:/usr/bin",
  });
  assert.deepEqual(onPath, ["--js-runtimes", "deno"]);

  const offPath = jsRuntimeArgs({ name: "deno", path: "/home/u/.deno/bin/deno" }, null, {
    PATH: "/usr/bin",
  });
  assert.deepEqual(offPath, ["--js-runtimes", "deno:/home/u/.deno/bin/deno"]);

  assert.deepEqual(jsRuntimeArgs(null, null, { PATH: "/usr/bin" }), []);
  assert.deepEqual(
    jsRuntimeArgs(null, "/opt/bun/bin/bun", { PATH: "/usr/bin" }),
    ["--js-runtimes", "bun:/opt/bun/bin/bun"],
  );
});

test("runtime name is derived from an explicit path", () => {
  assert.equal(detectNameFromPath("/usr/bin/deno"), "deno");
  assert.equal(detectNameFromPath("C:\\\\tools\\\\bun.exe"), "bun");
  assert.equal(detectNameFromPath("/usr/bin/node"), "node");
});

test("candidate paths include PATH and common install dirs", () => {
  const paths = candidatePaths("deno", { PATH: "/custom/bin" }, "/home/u", "linux");
  assert.equal(paths.includes("/custom/bin/deno"), true);
  assert.equal(paths.includes("/home/u/.deno/bin/deno"), true);
});

test("detection reports unusable runtimes with a reason", async () => {
  const list = await detectJsRuntimes({
    platform: "linux",
    home: "/home/u",
    env: { PATH: "/usr/bin" },
    exists: (file) => file === "/usr/bin/node",
    probe: async () => "v20.20.2",
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].supported, false);
  assert.match(String(list[0].reason), /22\+/);

  const summary = runtimeSummary(list);
  assert.equal(summary.ok, false);
  assert.match(summary.message, /Node 20/);
  assert.match(String(summary.hint), /Deno/);
});

test("detection prefers deno even when node is also present", async () => {
  const files = new Set(["/home/u/.deno/bin/deno", "/usr/bin/node"]);
  const list = await detectJsRuntimes({
    platform: "linux",
    home: "/home/u",
    env: { PATH: "/usr/bin" },
    exists: (file) => files.has(file),
    probe: async (file) => (file.includes("deno") ? "2.9.8" : "v22.4.0"),
  });
  assert.equal(pickJsRuntime(list)?.name, "deno");
  assert.equal(runtimeSummary(list).ok, true);
});
