import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Cookie session manager.
 *
 * This is the honest answer to "make Instagram/Reddit/Vimeo work": those sites
 * require a logged-in session. The app must therefore (a) accept the user's own
 * cookies, (b) tell them *which* platform a cookie file actually covers, and
 * (c) never leak those cookies into logs or backups.
 */

export const COOKIE_PLATFORMS = [
  { id: "instagram", label: "إنستغرام", domains: ["instagram.com", "cdninstagram.com", "instagr.am"] },
  { id: "facebook", label: "فيسبوك", domains: ["facebook.com", "fbcdn.net", "fb.com"] },
  { id: "reddit", label: "ريديت", domains: ["reddit.com", "redd.it"] },
  { id: "vimeo", label: "Vimeo", domains: ["vimeo.com"] },
  { id: "twitter", label: "X / تويتر", domains: ["twitter.com", "x.com", "twimg.com"] },
  { id: "tiktok", label: "تيك توك", domains: ["tiktok.com"] },
  { id: "youtube", label: "يوتيوب", domains: ["youtube.com", "google.com", "googlevideo.com"] },
  { id: "pinterest", label: "Pinterest", domains: ["pinterest.com", "pinimg.com"] },
] as const;

export type CookieDomain = { domain: string; name: string };

/** Parses a Netscape cookies.txt file. Malformed lines are ignored, never thrown. */
export function parseCookieFile(content: string): CookieDomain[] {
  const rows: CookieDomain[] = [];
  for (const rawLine of (content ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const domain = parts[0].replace(/^\./, "").toLowerCase();
    const name = parts[5];
    if (!domain || !name) continue;
    if (/^#httponly_/i.test(name)) continue;
    rows.push({ domain, name });
  }
  return rows;
}

export type CookieCoverage = {
  hasCookies: boolean;
  count: number;
  platforms: { id: string; label: string; domains: number; covered: boolean }[];
  /** True when the file has an obvious session cookie for the platform. */
  sessions: string[];
};

export function cookieCoverage(content: string | null): CookieCoverage {
  const rows = content ? parseCookieFile(content) : [];
  const platforms = COOKIE_PLATFORMS.map((platform) => {
    const matched = rows.filter((row) =>
      platform.domains.some((domain) => row.domain === domain || row.domain.endsWith(`.${domain}`)),
    );
    const names = new Set(matched.map((row) => row.name.toLowerCase()));
    const hasSession = ["sessionid", "sessionid_ss", "c_user", "reddit_session", "auth_token", "sid", "login"].some(
      (key) => [...names].some((name) => name.includes(key)),
    );
    return {
      id: platform.id,
      label: platform.label,
      domains: matched.length,
      covered: matched.length > 0 && hasSession,
    };
  });
  return {
    hasCookies: rows.length > 0,
    count: rows.length,
    platforms,
    sessions: platforms.filter((platform) => platform.covered).map((platform) => platform.label),
  };
}

export function defaultCookiePath(): string {
  return path.join(process.cwd(), "data", "cookies.txt");
}

export function readCookieFile(filePath?: string | null): string | null {
  const target = filePath?.trim() || defaultCookiePath();
  try {
    if (!existsSync(target)) return null;
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

/**
 * Accept only Netscape cookie files. A JSON export (EditThisCookie etc.) is a
 * common mistake; converting silently would be surprising, so we say so.
 */
export function validateCookieContent(content: string): { ok: true; count: number } | { ok: false; reason: string } {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return { ok: false, reason: "الملف فارغ." };
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return {
      ok: false,
      reason: "هذا تصدير JSON. المطلوب تنسيق Netscape (cookies.txt) — صدّره بإضافة «Get cookies.txt LOCALLY».",
    };
  }
  const rows = parseCookieFile(trimmed);
  if (rows.length === 0) {
    return { ok: false, reason: "لا يحتوي الملف أي سطر كوكيز صالح بتنسيق Netscape." };
  }
  return { ok: true, count: rows.length };
}

export function saveCookieFile(content: string, filePath?: string | null): { ok: true; path: string; count: number } | { ok: false; reason: string } {
  const check = validateCookieContent(content);
  if (!check.ok) return check;
  const target = filePath?.trim() || defaultCookiePath();
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: 0o600 });
    return { ok: true, path: target, count: check.count };
  } catch (error) {
    return { ok: false, reason: `تعذّر حفظ الملف: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function cookiesHint(): string {
  return `صدّر الكوكيز من متصفحك بصيغة Netscape إلى ملف ثم ارفعه من الإعدادات، أو استخدم «استيراد من متصفح» مباشرة. مسار مقترح: ${path.join("~", ".blackhole", "cookies.txt")} (الافتراضي: ${defaultCookiePath()}).`;
}

export function homeCookiePath(): string {
  return path.join(os.homedir(), ".blackhole", "cookies.txt");
}
