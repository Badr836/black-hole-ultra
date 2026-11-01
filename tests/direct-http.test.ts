import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadDirect, isDirectFileUrl, probeDirect } from "../src/lib/direct-http";

/** Deterministic bytes so hashes are comparable and nothing random leaks in. */
const DATA = Buffer.alloc(96 * 1024);
for (let i = 0; i < DATA.length; i += 1) DATA[i] = (i * 31 + 7) % 256;
const SHA = createHash("sha256").update(DATA).digest("hex");

type ServerOpts = {
  data?: Buffer;
  etag?: string;
  ignoreRange?: boolean;
  /** Close the socket after N body bytes — a genuine mid-transfer failure. */
  cutAfter?: number;
  contentType?: string;
};

async function serve(opts: ServerOpts = {}) {
  const data = opts.data ?? DATA;
  const etag = opts.etag ?? '"v1"';
  const server = http.createServer((req, res) => {
    const total = data.length;
    const range = req.headers.range;
    const headers: Record<string, string> = {
      "Content-Type": opts.contentType ?? "video/mp4",
      ETag: etag,
      "Accept-Ranges": opts.ignoreRange ? "none" : "bytes",
    };

    if (range && !opts.ignoreRange) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : total - 1;
      if (start >= total) {
        res.writeHead(416, { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" });
        res.end();
        return;
      }
      const slice = data.subarray(start, end + 1);
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(slice.length),
      });
      if (opts.cutAfter != null) {
        res.write(slice.subarray(0, opts.cutAfter));
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.end(slice);
      return;
    }

    res.writeHead(200, { ...headers, "Content-Length": String(total) });
    if (opts.cutAfter != null) {
      res.write(data.subarray(0, opts.cutAfter));
      setTimeout(() => res.destroy(), 10);
      return;
    }
    res.end(data);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/clip.mp4`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function workdir() {
  return mkdtempSync(path.join(tmpdir(), "bh-direct-"));
}

const fastSleep = () => Promise.resolve();

test("isDirectFileUrl only accepts real file URLs", () => {
  assert.equal(isDirectFileUrl("https://cdn.example.com/a/b/clip.mp4"), true);
  assert.equal(isDirectFileUrl("https://cdn.example.com/a/b/clip.mp4?token=abc"), true);
  assert.equal(isDirectFileUrl("https://example.com/watch/page"), false);
  assert.equal(isDirectFileUrl("https://example.com/page.mp4.html"), false);
  assert.equal(isDirectFileUrl("not a url"), false);
});

test("probe reports size, validators and Range support", async () => {
  const s = await serve();
  try {
    const probe = await probeDirect(s.url);
    assert.ok(probe);
    assert.equal(probe.size, DATA.length);
    assert.equal(probe.acceptRanges, true);
    assert.equal(probe.etag, '"v1"');
    assert.equal(probe.contentType, "video/mp4");
  } finally {
    await s.close();
  }
});

test("probe refuses an HTML page whose URL is not a media file", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const probe = await probeDirect(`http://127.0.0.1:${port}/index.html`);
    assert.equal(probe, null);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a full direct download produces identical bytes", async () => {
  const s = await serve();
  const dir = workdir();
  try {
    const dest = path.join(dir, "clip.mp4");
    const progress: number[] = [];
    const result = await downloadDirect({
      url: s.url,
      destPath: dest,
      sleep: fastSleep,
      onProgress: (p) => progress.push(p.bytes),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.bytes, DATA.length);
      assert.equal(result.verified, true);
      assert.equal(createHash("sha256").update(readFileSync(dest)).digest("hex"), SHA);
    }
    assert.ok(progress.length > 0, "progress must be reported from real writes");
    assert.equal(existsSync(`${dest}.part`), false, "the .part file is published, not left behind");
  } finally {
    await s.close();
  }
});

test("an interrupted transfer resumes from the last stored byte", async () => {
  const dir = workdir();
  const dest = path.join(dir, "clip.mp4");
  const broken = await serve({ cutAfter: 40 * 1024 });
  let first;
  try {
    first = await downloadDirect({ url: broken.url, destPath: dest, maxAttempts: 2, sleep: fastSleep });
  } finally {
    await broken.close();
  }
  assert.equal(first.ok, false);
  const partialBytes = statSync(`${dest}.part`).size;
  assert.ok(partialBytes > 0 && partialBytes < DATA.length, `partial size ${partialBytes}`);

  const good = await serve();
  try {
    const second = await downloadDirect({ url: good.url, destPath: dest, sleep: fastSleep });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.resumedFrom, partialBytes, "must not re-download the stored bytes");
      assert.equal(createHash("sha256").update(readFileSync(dest)).digest("hex"), SHA);
    }
  } finally {
    await good.close();
  }
});

test("a server that ignores Range forces a clean restart instead of corruption", async () => {
  const dir = workdir();
  const dest = path.join(dir, "clip.mp4");
  // Pre-seed a partial file as if a previous attempt had written it.
  writeFileSync(`${dest}.part`, DATA.subarray(0, 10_000));

  const s = await serve({ ignoreRange: true });
  try {
    const result = await downloadDirect({ url: s.url, destPath: dest, sleep: fastSleep });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.restarted, true);
    assert.equal(createHash("sha256").update(readFileSync(dest)).digest("hex"), SHA);
  } finally {
    await s.close();
  }
});

test("a changed ETag invalidates the stored bytes (If-Range → full body)", async () => {
  const dir = workdir();
  const dest = path.join(dir, "clip.mp4");
  writeFileSync(`${dest}.part`, DATA.subarray(0, 10_000));

  const s = await serve({ etag: '"v2"' });
  try {
    const result = await downloadDirect({
      url: s.url,
      destPath: dest,
      expectedEtag: '"v1"', // validator captured with the old bytes
      sleep: fastSleep,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.restarted, true, "server answered 200 because If-Range did not match");
      assert.equal(createHash("sha256").update(readFileSync(dest)).digest("hex"), SHA);
    }
  } finally {
    await s.close();
  }
});

test("an already complete .part is accepted without re-downloading", async () => {
  const dir = workdir();
  const dest = path.join(dir, "clip.mp4");
  writeFileSync(`${dest}.part`, DATA);

  const s = await serve();
  try {
    const result = await downloadDirect({ url: s.url, destPath: dest, expectedSize: DATA.length, sleep: fastSleep });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.bytes, DATA.length);
    assert.equal(createHash("sha256").update(readFileSync(dest)).digest("hex"), SHA);
  } finally {
    await s.close();
  }
});

test("a truncated body is reported as a size failure, never as success", async () => {
  const dir = workdir();
  const dest = path.join(dir, "clip.mp4");
  // Advertise more bytes than are delivered: the classic lying CDN.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(DATA.length), ETag: '"v1"' });
    res.end(DATA.subarray(0, 5_000));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const result = await downloadDirect({
      url: `http://127.0.0.1:${port}/clip.mp4`,
      destPath: dest,
      maxAttempts: 2,
      sleep: fastSleep,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "size");
    assert.equal(existsSync(dest), false, "an unverified file must never be published");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("an expired URL is refreshed once, then the download continues", async () => {
  const dir = workdir();
  const dest = path.join(dir, "clip.mp4");
  const good = await serve();
  let refreshed = 0;

  const expiring = http.createServer((_req, res) => {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("expired");
  });
  await new Promise<void>((r) => expiring.listen(0, "127.0.0.1", r));
  const addr = expiring.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const result = await downloadDirect({
      url: `http://127.0.0.1:${port}/clip.mp4`,
      destPath: dest,
      sleep: fastSleep,
      refreshUrl: async () => {
        refreshed += 1;
        return good.url;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(refreshed, 1, "exactly one re-extraction attempt");
    assert.equal(createHash("sha256").update(readFileSync(dest)).digest("hex"), SHA);
  } finally {
    await new Promise<void>((r) => expiring.close(() => r()));
    await good.close();
  }
});
