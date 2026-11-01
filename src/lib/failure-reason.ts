/**
 * Failure taxonomy for source errors.
 *
 * The UI used to show whatever the extractor printed — accurate but useless to a
 * user ("ERROR: [youtube] … Sign in to confirm you're not a bot"). This module
 * turns the raw message into a *stable code* plus an honest, actionable sentence,
 * so the queue can say **why** a source failed instead of only that it failed.
 *
 * Rules are ordered: the first match wins. Ordering matters because overlapping
 * wording is common — "403" can be an expired signed URL *or* an auth wall, and
 * "sign in" appears both in real auth walls and in datacenter-IP challenges.
 *
 * Pure: no I/O, no clock, no randomness — unit-testable.
 */

export type FailureCode =
  | "unsupported_extractor"
  | "unsupported_format"
  | "network"
  | "datacenter_ip"
  | "auth_required"
  | "expired_url"
  | "drm"
  | "rate_limit"
  | "missing_binary"
  | "disk"
  | "stalled"
  | "integrity"
  | "cancelled"
  | "unknown";

export type FailureInfo = {
  code: FailureCode;
  /** Short Arabic label for the queue row. */
  label: string;
  /** What the user can actually do about it (Arabic). */
  hint: string;
  /** Whether retrying the same job can plausibly succeed. */
  retryable: boolean;
};

type Rule = { code: FailureCode; pattern: RegExp; info: FailureInfo };

const INFO: Record<FailureCode, Omit<FailureInfo, "code">> = {
  unsupported_extractor: {
    label: "مصدر غير مدعوم",
    hint: "لا يوجد مستخرج لهذا الرابط في yt-dlp/gallery-dl. تأكد أن الرابط صفحة محتوى وليس صفحة رئيسية أو رابطاً داخلياً.",
    retryable: false,
  },
  unsupported_format: {
    label: "صيغة غير متاحة",
    hint: "الصيغة أو الجودة المطلوبة غير معروضة من المصدر. اختر «أفضل جودة» أو صيغة أخرى من قائمة التحليل.",
    retryable: false,
  },
  network: {
    label: "فشل شبكة",
    hint: "انقطاع اتصال أو مهلة من المصدر. أعد المحاولة — والتحميل المباشر يكمل من آخر بايت محفوظ إن كان المصدر يدعم Range.",
    retryable: true,
  },
  datacenter_ip: {
    label: "حظر عنوان مركز بيانات",
    hint: "المصدر يرفض عناوين الخوادم (فحص «لست روبوتاً»). الحلول المشروعة: كوكيز جلستك من الإعدادات، أو تشغيل التطبيق من شبكة منزلية. لا يستخدم التطبيق وكلاء ولا تجاوزاً.",
    retryable: false,
  },
  auth_required: {
    label: "يتطلب تسجيل دخول",
    hint: "المحتوى خلف حساب. أضف ملف cookies.txt من الإعدادات (جلسة المتصفح) — هذا ما يفعله التطبيق ولا يتجاوزه.",
    retryable: false,
  },
  expired_url: {
    label: "رابط موقّع منتهي",
    hint: "انتهت (صلاحية|صلاحي) رابط الوسائط الموقّع. أعد التحليل للحصول على رابط جديد ثم أعد المحاولة.",
    retryable: true,
  },
  drm: {
    label: "محمي بـ DRM",
    hint: "المحتوى مشفّر (Widevine/PlayReady). التطبيق لا يزيل ولا يتجاوز الحماية التقنية، ولن يفعل.",
    retryable: false,
  },
  rate_limit: {
    label: "تجاوز حد الطلبات (429)",
    hint: "المصدر يحدّ عدد الطلبات من هذا العنوان. انتظر من دقائق إلى ساعات أو أضف كوكيز جلسة.",
    retryable: true,
  },
  missing_binary: {
    label: "أداة ناقصة",
    hint: "أحد المحركات (yt-dlp/gallery-dl/FFmpeg/N_m3u8DL-RE) غير موجود. ثبّته أو حدّد مساره من الإعدادات.",
    retryable: false,
  },
  disk: {
    label: "مساحة قرص",
    hint: "لا توجد مساحة كافية أو تعذّرت الكتابة في مجلد الحفظ. حرّر مساحة أو غيّر المجلد.",
    retryable: true,
  },
  stalled: {
    label: "توقف بلا بيانات",
    hint: "توقف المحرك عن إرسال أي بيانات للمدة المسموحة، فأُوقفت المهمة. تحقق من الشبكة/الكوكيز ثم أعد المحاولة.",
    retryable: true,
  },
  integrity: {
    label: "ملف غير مكتمل",
    hint: "انتهى التنزيل لكن الحجم أو المحتوى لا يطابق المصدر. أعد المحاولة — الاستئناف سيبدأ من البايتات الناقصة.",
    retryable: true,
  },
  cancelled: { label: "أُلغيت", hint: "أوقفتَ المهمة.", retryable: true },
  unknown: {
    label: "فشل غير مصنّف",
    hint: "لم يتعرّف المصنّف على السبب. افتح سجل المهمة وأرسله للمراجعة.",
    retryable: true,
  },
};

const RULES: { code: FailureCode; pattern: RegExp }[] = [
  // DRM first: never treat it as a transient/network problem.
  { code: "drm", pattern: /\bdrm\b|widevine|playready|fairplay|encrypted media|مشفّر|محمي\s*بـ?\s*DRM/i },

  // Datacenter-IP challenge before generic auth ("sign in to confirm you're not a bot").
  {
    code: "datacenter_ip",
    pattern:
      /not a bot|verify you'?re not a bot|confirm you'?re not a bot|automated (queries|requests)|bot.?check|cloudflare|captcha|unsusual traffic|unusual traffic/i,
  },

  { code: "rate_limit", pattern: /429|too many requests|rate.?limit/i },

  // Expired signed URL / dead link — before generic 403 auth wording.
  {
    code: "expired_url",
    pattern:
      /expired|has expired|signature|token.*invalid|410 gone|http error 410|the uploader has not made this video available|no longer available|انتهت (صلاحية|صلاحي)/i,
  },

  {
    code: "auth_required",
    pattern:
      /login required|log ?in required|logged[- ]?in|sign in to|authentication|private( video| account)?|video is private|account is private|members[- ]only|age.?restricted|this video is private|requires? (a )?(login|subscription)|cookies?.*(required|missing)|تسجيل الدخول|كوكيز/i,
  },

  {
    code: "unsupported_extractor",
    pattern:
      /unsupported url|no video could be found|unable to extract|no suitable info|empty media|there is no video|no image\/video|not a valid url|is not a supported/i,
  },

  {
    code: "unsupported_format",
    pattern: /requested format (is )?not available|no such format|format not available|cannot merge|صيغة غير/i,
  },

  {
    code: "network",
    pattern:
      /enotfound|econnreset|econnrefused|etimedout|eai_again|getaddrinfo|network is unreachable|connection (reset|refused|aborted)|temporary failure in name resolution|http error 5\d\d|remote end closed/i,
  },

  {
    code: "missing_binary",
    pattern: /غير موجود|enoent|not found in path|command not found|no such file or directory/i,
  },

  { code: "disk", pattern: /enospc|no space left|disk quota|read-only file system|لا توجد مساحة/i },

  { code: "stalled", pattern: /توقّف المحرك|stopped producing|idle timeout/i },

  {
    code: "integrity",
    pattern: /حجم غير مطابق|size mismatch|incomplete|truncated|not complete|غير مكتمل/i,
  },

  { code: "cancelled", pattern: /أُلغيت|cancelled|canceled/i },
];

export function classifyFailure(message: string | null | undefined): FailureInfo {
  const text = (message ?? "").trim();
  if (!text) return { code: "unknown", ...INFO.unknown };
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { code: rule.code, ...INFO[rule.code] };
  }
  return { code: "unknown", ...INFO.unknown };
}

/** Short English/Arabic code list — used by diagnostics and tests. */
export const FAILURE_CODES = Object.keys(INFO) as FailureCode[];

/**
 * A `reason` string that is safe to store next to the human message: the code
 * alone. Kept separate so the DB can be queried/filtered by code later.
 */
export function failureCodeOf(message: string | null | undefined): FailureCode {
  return classifyFailure(message).code;
}
