import { spawnSync } from "node:child_process";

const targets = [
  ["YouTube", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"],
  ["YouTube Shorts", "https://www.youtube.com/shorts/dQw4w9WgXcQ"],
  ["Vimeo", "https://vimeo.com/76979871"],
  ["SoundCloud", "https://soundcloud.com/forss/flickermood"],
  ["Archive.org", "https://archive.org/details/BigBuckBunny_124"],
  ["Dailymotion", "https://www.dailymotion.com/video/x8j8g0k"],
  ["TikTok", "https://www.tiktok.com/@scout2015/video/6718335390845095173"],
  ["Instagram (post)", "https://www.instagram.com/p/CqLMqFqJ8QK/"],
  ["Instagram (reel)", "https://www.instagram.com/reel/C9xQ0Z1M3kL/"],
  ["Facebook (watch)", "https://www.facebook.com/watch/?v=10153231379946729"],
  ["X / Twitter", "https://x.com/github/status/1329269691324059648"],
  ["Reddit", "https://www.reddit.com/r/aww/comments/1c9k2z8/"],
];

const rows = [];
for (const [name, url] of targets) {
  const started = Date.now();
  const run = spawnSync("yt-dlp", ["-J", "--no-warnings", "--no-playlist", "--socket-timeout", "15", url], {
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  let verdict = "✗ فشل";
  let detail = "";
  if (run.status === 0) {
    try {
      const info = JSON.parse(run.stdout);
      verdict = "✓ يعمل";
      detail = `${info.extractor_key ?? info.extractor ?? "?"} · ${String(info.title ?? "").slice(0, 42)}`;
    } catch {
      detail = "خرج غير مفهوم";
    }
  } else {
    const lines = `${run.stderr ?? ""}`.split("\n").filter((l) => l.includes("ERROR"));
    detail = (lines[lines.length - 1] ?? run.stderr ?? "timeout")
      .replace(/^ERROR:\s*/, "")
      .slice(0, 110);
  }
  rows.push({ name, verdict, detail, ms, url });
  console.log(`${verdict.padEnd(9)} ${name.padEnd(20)} ${ms}ms  ${detail}`);
}

console.log("\n| المنصة | النتيجة | التفصيل |");
console.log("|---|---|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.verdict} | ${r.detail.replace(/\|/g, "/")} |`);
