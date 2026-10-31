import test from "node:test";
import assert from "node:assert/strict";
import {
  decideAccess,
  extractToken,
  isLoopbackHost,
  isPreviewHost,
  tokenEquals,
} from "../src/lib/access";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAccessToken, TOKEN_FILE, isPublicBind, writeTokenFile } from "../src/lib/access-token";

test("loopback hosts need no token", () => {
  for (const host of ["localhost:3000", "127.0.0.1:8080", "127.0.1.5", "[::1]:3000"]) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.equal(decideAccess({ host, hasConfiguredToken: true }).requireToken, false, host);
  }
});

test("LAN hosts require a token when one is configured", () => {
  for (const host of ["192.168.1.50:3000", "10.0.0.7:3000", "nas.local:3000", "169.254.0.21:3000"]) {
    assert.equal(isLoopbackHost(host), false, host);
    assert.equal(decideAccess({ host, hasConfiguredToken: true }).requireToken, true, host);
    assert.equal(decideAccess({ host, hasConfiguredToken: false }).requireToken, false, host);
  }
});

test("preview hosts stay open (they cannot send a custom header)", () => {
  for (const host of [
    "3000-abc.e2b.app",
    "app.vercel.app",
    "x.ngrok-free.app",
    "y.trycloudflare.com",
    "ad3299a3cf7371.lhr.life",
    "tidy-cat-99.loca.lt",
    "abc.a.free.pinggy.link",
    "x.serveo.net",
    "xyz.tunnelmole.net",
    "blackhole-ultra.tail1a2b3c.ts.net",
  ]) {
    assert.equal(isPreviewHost(host), true, host);
    assert.equal(decideAccess({ host, hasConfiguredToken: true }).requireToken, false, host);
  }
  assert.equal(isPreviewHost("localhost:3000"), false);
});

test("explicit opt-out beats everything", () => {
  const decision = decideAccess({ host: "192.168.1.50:3000", hasConfiguredToken: true, allowUnauthenticated: true });
  assert.equal(decision.requireToken, false);
});

test("token comparison is exact and rejects empties", () => {
  assert.equal(tokenEquals("abc", "abc"), true);
  assert.equal(tokenEquals("abc", "abd"), false);
  assert.equal(tokenEquals("abc", "abcd"), false);
  assert.equal(tokenEquals("", ""), false);
  assert.equal(tokenEquals(null, "x"), false);
  assert.equal(tokenEquals(" x ", "x"), true);
});

test("token can arrive by header, cookie or query", () => {
  assert.equal(extractToken({ header: "h", cookie: "c", query: "q" }), "h");
  assert.equal(extractToken({ header: null, cookie: "c", query: "q" }), "c");
  assert.equal(extractToken({ header: "", cookie: "", query: "q" }), "q");
  assert.equal(extractToken({}), null);
});

test("public bind detection covers 0.0.0.0 and ::", () => {
  assert.equal(isPublicBind("0.0.0.0"), true);
  assert.equal(isPublicBind("::"), true);
  assert.equal(isPublicBind("127.0.0.1"), false);
  // HOSTNAME decides the bind; a private bind never gets a generated token.
  assert.equal(resolveAccessToken({ HOSTNAME: "127.0.0.1" }, null).source, "loopback");
});

test("token resolution: env wins, then file, then generated, then opt-out", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bh-token-"));
  const tokenFile = path.join(dir, "access-token.txt");
  try {
    const env = resolveAccessToken({ BLACKHOLE_TOKEN: "  env-token  ", HOSTNAME: "0.0.0.0" }, tokenFile);
    assert.deepEqual([env.token, env.source], ["env-token", "env"]);
    // An explicit env token is persisted so the UI can show it later.
    assert.equal(readFileSync(tokenFile, "utf8").trim(), "env-token");
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);

    const fromFile = resolveAccessToken({ HOSTNAME: "0.0.0.0" }, tokenFile);
    assert.deepEqual([fromFile.token, fromFile.source], ["env-token", "file"]);

    writeFileSync(tokenFile, "");
    const generated = resolveAccessToken({ HOSTNAME: "0.0.0.0" }, tokenFile);
    assert.equal(generated.source, "generated");
    assert.match(generated.token ?? "", /^[0-9a-f]{32,}$/);
    assert.equal(readFileSync(tokenFile, "utf8").trim(), generated.token);
    // Persisted, so a restart reuses the same token instead of locking the user out.
    assert.equal(resolveAccessToken({ HOSTNAME: "0.0.0.0" }, tokenFile).token, generated.token);

    const off = resolveAccessToken({ BLACKHOLE_AUTO_TOKEN: "0", HOSTNAME: "0.0.0.0" }, tokenFile);
    assert.deepEqual([off.token, off.source], [null, "disabled"]);

    // A token the user set is never overwritten by an empty env on a private bind.
    assert.equal(writeTokenFile("mine", tokenFile), tokenFile);
    assert.equal(resolveAccessToken({ BLACKHOLE_TOKEN: "mine", HOSTNAME: "127.0.0.1" }, tokenFile).token, "mine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token file name is stable for the docs", () => {
  assert.equal(TOKEN_FILE.endsWith("access-token.txt"), true);
});
