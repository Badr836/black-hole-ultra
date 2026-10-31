#!/usr/bin/env node
/**
 * Upstream watcher — the "always learn from GitHub" pipeline.
 *
 * Queries the GitHub API for the engines and reference apps this project builds
 * on, compares them with what is installed locally, and prints what to update.
 *
 *   npm run upstream:check           # report only
 *   npm run upstream:check -- --json # machine readable
 *   npm run upstream:update          # run the safe update commands
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPOS = [
  { repo: "yt-dlp/yt-dlp", binary: "yt-dlp", args: ["--version"], kind: "engine", update: ["-U"] },
  { repo: "mikf/gallery-dl", binary: "gallery-dl", args: ["--version"], kind: "engine", update: ["--update"] },
  { repo: "FFmpeg/FFmpeg", binary: "ffmpeg", args: ["-version"], kind: "engine", update: null },
  { repo: "JunkFood02/Seal", binary: null, kind: "reference" },
  { repo: "deniscerri/ytdlnis", binary: null, kind: "reference" },
  { repo: "GopeedLab/gopeed", binary: null, kind: "reference" },
  { repo: "imputnet/cobalt", binary: null, kind: "reference" },
  { repo: "iawia002/lux", binary: null, kind: "candidate" },
  { repo: "instaloader/instaloader", binary: null, kind: "candidate" },
  { repo: "nilaoda/N_m3u8DL-RE", binary: null, kind: "candidate" },
];

const headers = { Accept: "application/vnd.github+json", "User-Agent": "blackhole-ultra-upstream-check" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

function installedVersion(binary, args) {
  if (!binary) return null;
  try {
    const out = execFileSync(binary, args, { encoding: "utf8", timeout: 15_000 });
    return out.split("\n")[0].trim().replace(/^ffmpeg version\s+/, "").split(" ")[0];
  } catch {
    return null;
  }
}

const json = process.argv.includes("--json");

// Query all repositories in parallel: sequential calls took ~90s, this takes ~3s.
const settled = await Promise.allSettled(
  REPOS.map(async (entry) => {
    const [repo, release] = await Promise.all([
      api(`/repos/${entry.repo}`),
      api(`/repos/${entry.repo}/releases/latest`).catch(() => null),
    ]);
    return { entry, repo, release };
  }),
);

const rows = [];
const warnings = [];

for (const outcome of settled) {
  if (outcome.status === "rejected") {
    warnings.push(`تعذّر الاستعلام: ${outcome.reason?.message ?? outcome.reason}`);
    continue;
  }
  const { entry, repo, release } = outcome.value;
  try {
    const installed = installedVersion(entry.binary, entry.args ?? []);
    const latest = release?.tag_name ?? null;
    const behind = Boolean(installed && latest && !String(latest).includes(installed) && installed.length > 3);
    rows.push({
      repo: entry.repo,
      kind: entry.kind,
      stars: repo.stargazers_count,
      license: repo.license?.spdx_id ?? null,
      pushedAt: repo.pushed_at,
      latest,
      publishedAt: release?.published_at ?? null,
      installed,
      behind,
      updateHint: entry.update ? `${entry.binary} ${entry.update.join(" ")}` : null,
    });
    if (behind) warnings.push(`${entry.binary}: مثبّت ${installed} · أحدث ${latest} → ${entry.binary} ${entry.update?.join(" ") ?? ""}`);
  } catch (error) {
    warnings.push(`${entry.repo}: ${error.message}`);
  }
}

const report = { checkedAt: new Date().toISOString(), rows, warnings };

// Cache on disk so the UI keeps working when the GitHub rate limit is hit.
try {
  const dir = path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "upstream-cache.json"), JSON.stringify(report, null, 2));
} catch {
  /* cache is optional */
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("مستودع".padEnd(30), "نجوم".padStart(7), "  مثبّت", "".padEnd(12), "أحدث إصدار");
  for (const row of rows) {
    console.log(
      row.repo.padEnd(30),
      String(row.stars ?? "—").padStart(7),
      "  " + String(row.installed ?? "—").padEnd(12),
      row.latest ?? "—",
      row.behind ? "  ⬆ يحتاج تحديث" : "",
    );
  }
  if (warnings.length) {
    console.log("\nتنبيهات:");
    for (const warning of warnings) console.log(`  ⚠ ${warning}`);
    if (warnings.some((w) => /403/.test(w))) {
      console.log("  ℹ حدّ GitHub المجاني للطلبات انتهى مؤقتاً. اضبط GITHUB_TOKEN لرفعه إلى 5000/ساعة.");
    }
  } else {
    console.log("\n✓ كل المحركات المثبّتة محدّثة.");
  }
}

if (process.argv.includes("--update")) {
  console.log("\nتحديث المحركات…");
  for (const entry of REPOS) {
    if (!entry.update || !entry.binary) continue;
    try {
      execFileSync(entry.binary, entry.update, { stdio: "inherit", timeout: 300_000 });
    } catch {
      const pip = spawnSync("pip", ["install", "-U", entry.repo.split("/")[1]], { stdio: "inherit" });
      if (pip.status !== 0) console.log(`  (تعذّر تحديث ${entry.binary} تلقائياً — حدّثه يدوياً)`);
    }
  }
}
