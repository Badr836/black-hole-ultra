/**
 * A tiny HLS origin that refuses requests without the right Referer + Cookie.
 *
 * Why it exists: N_m3u8DL-RE is in this project *because* some HLS links are
 * session-bound (Referer/Hotlink protection, logged-in CDNs). Public test
 * streams never exercise that path, so this server reproduces it locally with
 * real segments produced by FFmpeg — deterministic, offline, and it can assert
 * which headers the downloader actually sent (see `requests.log`).
 *
 * Usage: node protected-hls-server.mjs <dir> <port> <referer> <cookieValue>
 * Env:   HLS_LOG=<file>  (default <dir>/../requests.log)
 *
 * `<referer>` may be:
 *   - an exact URL      → it must match exactly;
 *   - `same-origin`     → anything from `http://127.0.0.1:<port>` is accepted
 *                         (this is what "derive the Referer from the stream
 *                         itself" is supposed to satisfy);
 *   - `*` or empty      → referer not checked (cookie-only protection).
 */
import { createServer } from "node:http";
import { appendFileSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const [dir, portRaw, referer, cookieValue] = process.argv.slice(2);
if (!dir || !portRaw) {
  console.error("usage: protected-hls-server.mjs <dir> <port> <referer> <cookieValue>");
  process.exit(2);
}
const port = Number(portRaw);
const logFile = process.env.HLS_LOG ?? path.join(dir, "..", "requests.log");

const TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".key": "application/octet-stream",
};

function cookieHas(header) {
  if (!cookieValue) return true;
  return (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .includes(`session=${cookieValue}`);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const gotReferer = req.headers.referer ?? "";
  const gotCookie = req.headers.cookie ?? "";
  const ownOrigin = `http://127.0.0.1:${port}`;
const refererOk =
  !referer ||
  referer === "*" ||
  (referer === "same-origin"
    ? (() => {
        try {
          return new URL(gotReferer).origin === ownOrigin;
        } catch {
          return false;
        }
      })()
    : gotReferer === referer);
  const cookieOk = cookieHas(gotCookie);
  appendFileSync(
    logFile,
    `${new Date().toISOString()}\t${url.pathname}\treferer=${JSON.stringify(gotReferer)}\tcookie=${JSON.stringify(gotCookie)}\t${refererOk && cookieOk ? "ALLOW" : "DENY"}\n`,
  );

  if (!refererOk || !cookieOk) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("403 forbidden: this stream requires Referer and Cookie headers\n");
    return;
  }

  const target = path.join(dir, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!target.startsWith(path.resolve(dir))) {
    res.writeHead(400).end("bad path");
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = readFileSync(target);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(target)] ?? "application/octet-stream",
    "content-length": body.length,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  res.end(body);
}).listen(port, "127.0.0.1", () => {
  console.log(`protected HLS origin on http://127.0.0.1:${port}/master.m3u8 (referer=${referer || "*"}, cookie=${cookieValue || "*"})`);
});
