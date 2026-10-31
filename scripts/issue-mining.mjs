#!/usr/bin/env node
/**
 * استخراج ملاحظات المستخدمين الحقيقية من GitHub.
 *
 * يجمع أكثر البلاغات/الطلبات تفاعلاً (reactions) من التطبيقات المرجعية،
 * ويصنّفها إلى موضوعات، ثم يكتب تقريراً في docs/issue-mining.md.
 *
 *   npm run issues:mine
 *
 * يتطلب شبكة. يحترم حدّ GitHub: يتوقف ويُبلغ عند 403/429.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPOS = [
  "JunkFood02/Seal",
  "deniscerri/ytdlnis",
  "GopeedLab/gopeed",
  "imputnet/cobalt",
  "yt-dlp/yt-dlp",
  "mikf/gallery-dl",
  "agalwood/Motrix",
];

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "blackhole-ultra-issue-mining",
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, attempt = 0) {
  const res = await fetch(url, { headers });
  if (res.status === 403 || res.status === 429) {
    if (attempt < 2) {
      await sleep(20_000);
      return get(url, attempt + 1);
    }
    throw new Error(`GitHub rate limit (${res.status})`);
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return res.json();
}

/** موضوعات مأخوذة من الشكاوى المتكررة فعلياً، لا من قائمة نظرية. */
const THEMES = [
  { id: "auth", label: "تسجيل الدخول/الكوكيز", re: /cookie|login|sign in|logged|account|auth|private|age/i },
  { id: "bot", label: "حظر «تأكد أنك لست روبوتاً»", re: /bot|confirm you|player_client|captcha|403/i },
  { id: "speed", label: "السرعة والتزامن", re: /slow|speed|concurren|parallel|faster|throttl|bandwidth/i },
  { id: "quality", label: "الجودة/الصيغ/الدمج", re: /format|quality|codec|resolution|merge|mux|vp9|av1|hdr|4k/i },
  { id: "subtitles", label: "الترجمة والتضمين", re: /subtitle|caption|srt|embed/i },
  { id: "crash", label: "الأعطال والاستقرار", re: /crash|freeze|stuck|hang|anr|force close|not working|broken/i },
  { id: "playlist", label: "قوائم التشغيل والدفعات", re: /playlist|batch|queue|bulk|select all|channel/i },
  { id: "naming", label: "التسمية ومجلد الحفظ", re: /filename|template|naming|path|folder|destination|storage/i },
  { id: "resume", label: "الاستئناف وإعادة المحاولة", re: /resume|retry|continue|partial|interrupt|pause/i },
  { id: "duplicate", label: "التكرار وحفظ السجل", re: /duplicate|already downloaded|archive|history|re-?download/i },
  { id: "sponsor", label: "SponsorBlock وتنقية المحتوى", re: /sponsor|chapter|trim|cut|ads/i },
  { id: "ui", label: "الواجهة والتجربة", re: /ui|ux|design|theme|dark|layout|share|notification/i },
  { id: "update", label: "التحديثات والمحركات", re: /update|version|outdated|extractor|release|build/i },
  { id: "drm", label: "DRM ومحتوى مدفوع", re: /drm|netflix|spotify|widevine|paid|premium/i },
];

function classify(text) {
  return THEMES.filter((theme) => theme.re.test(text)).map((theme) => theme.id);
}

const report = { generatedAt: new Date().toISOString(), repos: [] };

for (const repo of REPOS) {
  try {
    const query = encodeURIComponent(`repo:${repo} is:issue`);
    const url = `https://api.github.com/search/issues?q=${query}&sort=reactions&order=desc&per_page=25`;
    const data = await get(url);
    const items = (data.items ?? []).map((issue) => ({
      repo,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      comments: issue.comments,
      reactions:
        (issue.reactions?.total_count ?? 0) ||
        ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"].reduce(
          (sum, key) => sum + (issue.reactions?.[key] ?? 0),
          0,
        ),
      labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
      createdAt: issue.created_at,
      url: issue.html_url,
      body: String(issue.body ?? "").replace(/\s+/g, " ").slice(0, 500),
      themes: classify(`${issue.title} ${issue.body ?? ""}`),
    }));

    report.repos.push({ repo, totalCount: data.total_count, items });
    console.log(`${repo}: ${items.length} issues (top reactions ${items[0]?.reactions ?? 0})`);
    await sleep(2500);
  } catch (error) {
    console.log(`${repo}: FAILED — ${error.message}`);
    report.repos.push({ repo, error: error.message, items: [] });
  }
}

mkdirSync("data", { recursive: true });
writeFileSync(path.join("data", "issue-mining.json"), JSON.stringify(report, null, 2));

// ---- تجميع الموضوعات ----
const themeCounts = new Map();
const themeExamples = new Map();
for (const repo of report.repos) {
  for (const item of repo.items ?? []) {
    for (const theme of item.themes) {
      themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
      if (!themeExamples.has(theme)) themeExamples.set(theme, []);
      themeExamples.get(theme).push(item);
    }
  }
}

const sortedThemes = [...themeCounts.entries()].sort((a, b) => b[1] - a[1]);
const label = (id) => THEMES.find((theme) => theme.id === id)?.label ?? id;

const lines = [];
lines.push("# ملاحظات المستخدمين الحقيقية — استخراج من GitHub Issues");
lines.push("");
lines.push(`**تاريخ الاستخراج:** ${report.generatedAt.slice(0, 10)} · **المصدر:** GitHub Search API (مرتّب حسب التفاعل)`);
lines.push("");
lines.push("> هذا ليس رأياً: العناوين والتفاعلات منقولة كما هي. الرابط لكل بلاغ موجود في `data/issue-mining.json`.");
lines.push("");
lines.push("## أكثر الموضوعات تكراراً");
lines.push("");
lines.push("| الموضوع | عدد البلاغات/الطلبات | ما يعنيه عملياً |");
lines.push("|---|---|---|");
const meaning = {
  auth: "دعم الكوكيز أصبح شرطاً لا ميزة",
  bot: "يوتيوب يحظر «تأكد أنك لست روبوتاً» — الحل: تدوير player_client",
  speed: "المستخدمون يريدون تزامن/تسريع حقيقي (aria2c، أجزاء متعددة)",
  quality: "اختيار الصيغة والدمج بدون إعادة ترميز",
  subtitles: "تضمين الترجمة داخل الملف",
  crash: "الاستقرار أهم من المزايا الجديدة",
  playlist: "تحكم دقيق بعناصر القائمة",
  naming: "قالب التسمية ومجلد الحفظ",
  resume: "استئناف بعد انقطاع بلا فقدان",
  duplicate: "منع إعادة تحميل ما تم تحميله",
  sponsor: "SponsorBlock مطلوب بشدة",
  ui: "المشاركة والإشعارات والواجهة",
  update: "المحرك يتقادم والمواقع تتغيّر",
  drm: "طلبات DRM متكررة — مرفوضة دائماً",
};
for (const [theme, count] of sortedThemes) {
  lines.push(`| ${label(theme)} | ${count} | ${meaning[theme] ?? ""} |`);
}
lines.push("");
lines.push("## أعلى البلاغات تفاعلاً في كل تطبيق");
for (const repo of report.repos) {
  lines.push("");
  lines.push(`### ${repo.repo}`);
  if (repo.error) {
    lines.push(`> تعذّر الاستخراج: ${repo.error}`);
    continue;
  }
  lines.push("");
  lines.push("| # | البلاغ | التفاعل | التعليقات | الحالة |");
  lines.push("|---|---|---|---|---|");
  for (const item of (repo.items ?? []).slice(0, 10)) {
    lines.push(
      `| [${item.number}](${item.url}) | ${item.title.replace(/\|/g, "/").slice(0, 90)} | ${item.reactions} | ${item.comments} | ${item.state} |`,
    );
  }
}
lines.push("");
lines.push("## كيف تُرجم هذا إلى قرارات");
lines.push("");
lines.push("انظر `docs/agents/04-issue-decisions.md` — كل قرار هناك مسبوق برقم البلاغ الذي أنتجه.");
lines.push("");

mkdirSync("docs", { recursive: true });
writeFileSync(path.join("docs", "issue-mining.md"), lines.join("\n"));
console.log(`\n→ docs/issue-mining.md · ${sortedThemes.length} موضوعاً`);
