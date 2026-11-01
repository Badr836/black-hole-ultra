export type BrowserProfile = string;

export function isTikTokUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "tiktok.com" || host.endsWith(".tiktok.com");
  } catch {
    return /(?:^|\.)tiktok\.com/i.test(url);
  }
}

export type ImpersonationCaps = {
  supported: boolean;
  targets: string[];
};

/**
 * Parse `yt-dlp --list-impersonate-targets`.
 *
 * Important: yt-dlp exits 0 even when every target is marked `unavailable`
 * (e.g. when `curl_cffi` is not installed). The old code therefore assumed
 * impersonation worked and passed `--impersonate chrome` to every TikTok job,
 * which made *all* TikTok downloads fail with an unrelated error. We parse the
 * text, not the exit code.
 */
export function parseImpersonateTargets(stdout: string): string[] {
  const targets: string[] = [];
  for (const line of (stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\[info\]/i.test(line.trim())) continue;
    if (/^client\s+os\s+source/i.test(line.trim())) continue;
    if (/^-+\s+-+\s+-+/.test(line.trim())) continue;
    if (/unavailable/i.test(line)) continue;
    const client = line.trim().split(/\s{2,}/)[0]?.trim();
    if (client && /^(chrome|safari|firefox|edge|tor)/i.test(client)) targets.push(client);
  }
  return Array.from(new Set(targets));
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; caps: ImpersonationCaps } | null = null;

/** Cached capability probe. `runner` is injectable for tests. */
export async function impersonationCaps(
  runner: () => Promise<string>,
  now: () => number = Date.now,
): Promise<ImpersonationCaps> {
  if (cache && now() - cache.at < CACHE_TTL_MS) return cache.caps;
  let caps: ImpersonationCaps = { supported: false, targets: [] };
  try {
    const stdout = await runner();
    const targets = parseImpersonateTargets(stdout);
    caps = { supported: targets.length > 0, targets };
  } catch {
    caps = { supported: false, targets: [] };
  }
  cache = { at: now(), caps };
  return caps;
}

export function resetImpersonationCache(): void {
  cache = null;
}

export function profileForRetry(retry: number, available: string[]): BrowserProfile | null {
  if (available.length === 0) return null;
  const preferred = ["chrome", "safari", "firefox", "edge"];
  const usable = preferred.filter((client) =>
    available.some((target) => target.toLowerCase().startsWith(client)),
  );
  const list = usable.length > 0 ? usable : available.map((target) => target.toLowerCase());
  return list[Math.min(Math.max(retry, 0), list.length - 1)];
}

/**
 * Compatibility options for sites which reject plain Python HTTP clients.
 * TikTok frequently validates TLS/browser fingerprints; `--impersonate` is only
 * passed when the current yt-dlp build actually supports it.
 */
export function siteOptions(
  url: string,
  retry = 0,
  opts: { impersonate?: boolean; availableProfiles?: string[] } = {},
): string[] {
  if (!isTikTokUrl(url)) return [];
  const headers = [
    "--add-headers",
    "Referer:https://www.tiktok.com/",
    "--add-headers",
    "Accept-Language:ar,en-US;q=0.9,en;q=0.8",
  ];
  if (!opts.impersonate) return headers;
  const profile = profileForRetry(retry, opts.availableProfiles ?? []);
  if (!profile) return headers;
  return ["--impersonate", profile, ...headers];
}

export function friendlyDownloadError(raw: string, url: string): string {
  const clean = (raw ?? "").replace(/^ERROR:\s*/i, "").trim();
  if (/ffprobe not found|ffprobe.*not found/i.test(clean)) {
    return "FFprobe غير موجود. ثبّت حزمة FFmpeg الكاملة التي تتضمن ffmpeg وffprobe، أو ضع الملفين معاً في مجلد bin/.";
  }
  if (/ffmpeg not found|ffmpeg.*not found/i.test(clean)) {
    return "FFmpeg غير موجود. ثبّت حزمة FFmpeg الكاملة التي تتضمن ffmpeg وffprobe.";
  }
  if (/impersonat/i.test(clean) && /not available|unavailable|unsupported/i.test(clean)) {
    return "هذا البناء من yt-dlp لا يدعم انتحال بصمة المتصفح. ثبّت الحزمة الكاملة: pip install -U \"yt-dlp[default,curl-cffi]\" ثم أعد المحاولة.";
  }
  // YouTube #17456 / cobalt #1356: the media URL itself is refused.
  if (/unable to download video data.*403|403: Forbidden/i.test(clean) && /youtu/i.test(url)) {
    return "يوتيوب رفض تسليم بيانات الفيديو (HTTP 403). هذا ليس عطلاً في التطبيق: غالباً العنوان محجوب مؤقتاً، أو يلزم كوكيز جلسة، أو يحتاج محرك JavaScript حديث. " +
      "جرّب: إضافة cookies.txt من الإعدادات، إعادة المحاولة بعد دقائق، أو شبكة أخرى. جُرّب أيضاً عميل android_vr تلقائياً إن كان متاحاً.";
  }
  if (/requested format is not available/i.test(clean)) {
    return "الصيغة المطلوبة غير متاحة لهذا الرابط الآن. أعد التحليل واختر جودة أخرى.";
  }
  if (/video unavailable|private video|members-only|removed by the uploader/i.test(clean)) {
    return "المحتوى غير متاح (خاص أو محذوف أو مقيد بالعضوية). لا يتجاوز التطبيق أي حماية تقنية.";
  }
  // YouTube's *per-video* bot gate. Verified live on this deployment: the same
  // server+IP downloads other videos fine while this one answers
  // `playabilityStatus: LOGIN_REQUIRED — "Sign in to confirm you're not a bot"`,
  // so it is neither a broken extractor, nor a blanket IP ban, nor an age gate.
  // Say that, instead of the generic "login or age verification" line.
  if (/not a bot|confirm you[’']?re not a bot|confirm you are not a bot/i.test(clean) && /youtu/i.test(url)) {
    return (
      "يوتيوب رفض هذا الفيديو تحديداً بفحص «تأكيد أنك لست روبوتاً» " +
      "(playabilityStatus = LOGIN_REQUIRED). هذا حكم يوتيوب على الطلب وليس عطلاً في المستخرج: " +
      "فيديوهات أخرى تُحمَّل من نفس الجهاز بنجاح. " +
      "السبيل المشروع الوحيد لهذا الفيديو هو جلسة موثّقة: ⚙️ الإعدادات ← «جلسة الكوكيز» ← ارفع cookies.txt " +
      "مصدَّرة من متصفحك بعد تسجيل الدخول إلى يوتيوب. التطبيق لا يزوّر جلسة ولا يتجاوز أي قيد."
    );
  }
  if (/confirm your age|age-restricted|age restricted/i.test(clean)) {
    return "المحتوى مقيّد بالعمر. أضف ملف كوكيز لجلسة مسجّلة (⚙️ الإعدادات ← جلسة الكوكيز) إن كان لديك حق الوصول إليه.";
  }
  if (/sign in to confirm|please sign in/i.test(clean)) {
    return "الموقع يطلب تسجيل الدخول. أضف ملف كوكيز من الإعدادات إن كان لديك حق الوصول إلى هذا المحتوى.";
  }
  // ---- الاحتياجات الموثقة بالمختبر (docs/platform-support.md) ----
  if (/empty media response|login required|rate-limit|429/i.test(clean) && /instagram/i.test(clean)) {
    return "إنستغرام يرفض الطلبات غير المسجّلة (أو حظر مؤقت 429). أضف كوكيز جلسة من الإعدادات ← «استيراد Cookies من متصفح»، وسجّل دخولك في إنستغرام على ذلك المتصفح أولاً.";
  }
  if (/account authentication is required|use --cookies/i.test(clean)) {
    return "هذا المحتوى يتطلب تسجيل دخول. أضف كوكيز من الإعدادات (استيراد من متصفح أو ملف cookies.txt) — لا يتجاوز التطبيق أي حماية، بل يستخدم جلستك المشروعة فقط.";
  }
  if (/web client only works when logged-in/i.test(clean)) {
    return "الموقع (مثل Vimeo في وضع الإضافة) يشترط جلسة مسجّلة للعميل الإضافي. أضف كوكيز أو استخدم رابط الفيديو المباشر بدل صفحة الإضافة.";
  }
  if (/no video could be found/i.test(clean)) {
    return "لا يوجد فيديو/وسائط في هذا الرابط (قد يكون منشوراً نصياً أو صورة فقط).";
  }
  if (/unsupported url/i.test(clean)) {
    return "yt-dlp لا يدعم هذا الموقع أو شكل الرابط. جرّب الرابط المباشر للملف/المقطع، أو راجع قائمة المواقع المدعومة (1755 مستخرِجاً) في التشخيص.";
  }
  if (/drm|protected by|widevine|playready/i.test(clean)) {
    return "المحتوى محمي بـ DRM. التطبيق لا يتجاوز الحماية التقنية ولن يتمكن من تحميله — هذا قيد متعمّد.";
  }
  if (!isTikTokUrl(url)) return clean;
  if (/unexpected response|unable to download webpage|403|forbidden|blocked|sign in|cookies/i.test(clean)) {
    return "رفض TikTok الطلب. تأكد من تثبيت yt-dlp مع curl-cffi لانتحال بصمة المتصفح، وأعد المحاولة لاحقاً. التفاصيل: " + clean.slice(0, 280);
  }
  return clean;
}
