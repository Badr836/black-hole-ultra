/**
 * "Is YouTube usable from this machine right now?"
 *
 * Data-centre IPs (this sandbox included) get `Sign in to confirm you're not a
 * bot` for many videos, while others download fine. Instead of surfacing that as
 * a generic download failure, the app probes once and explains the state, so the
 * user knows whether to retry, switch network, or import cookies.
 *
 * Parsing lives here (pure, unit-tested); running yt-dlp lives in the route.
 */

export type YoutubeHealthState = "ok" | "bot-check" | "rate-limit" | "network" | "unknown";

export type YoutubeHealth = {
  state: YoutubeHealthState;
  /** Arabic, user-facing. */
  message: string;
  /** Concrete next step, or null when everything is fine. */
  action: string | null;
};

const BOT_CHECK = /sign in to confirm|confirm you'?re not a bot|not a bot|please sign in/i;
const RATE_LIMIT = /http error 429|too many requests|rate.?limit/i;
const NETWORK = /getaddrinfo|name or service not known|temporary failure|connection (?:refused|reset)|timed out|unable to download webpage|ssl/i;

export function classifyYoutubeProbe(result: {
  code: number | null;
  stderr: string;
  stdout: string;
}): YoutubeHealth {
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.code === 0 && !BOT_CHECK.test(text)) {
    return {
      state: "ok",
      message: "يوتيوب يستجيب من هذا الجهاز دون تحقّق إضافي.",
      action: null,
    };
  }
  if (BOT_CHECK.test(text)) {
    return {
      state: "bot-check",
      message:
        "يوتيوب يطلب «تأكيد أنك لست روبوتاً» لبعض الفيديوهات من عنوان IP هذا (شائع في الشبكات السحابية ومراكز البيانات).",
      action:
        "صدّر كوكيز من متصفحك إلى ملف cookies.txt وأضف مساره في الإعدادات، أو شغّل التطبيق من شبكة منزلية. بعض الفيديوهات تنجح دون كوكيز، فلا تخلط بين الحالتين.",
    };
  }
  if (RATE_LIMIT.test(text)) {
    return {
      state: "rate-limit",
      message: "يوتيوب يحجب الطلبات مؤقتاً بحد المعدل (HTTP 429) من هذا العنوان.",
      action: "انتظر من دقائق إلى ساعات، أو استخدم كوكيز جلسة، أو غيّر الشبكة.",
    };
  }
  if (NETWORK.test(text)) {
    return {
      state: "network",
      message: "تعذّر الوصول إلى يوتيوب من هذا الجهاز (مشكلة شبكة/DNS/TLS).",
      action: "تحقّق من الاتصال أو إعدادات الوسيط (proxy) ثم أعد الفحص.",
    };
  }
  return {
    state: "unknown",
    message: "لم يُحدَّد سبب فشل فحص يوتيوب.",
    action: "جرّب تحميلاً حقيقياً؛ سيُظهر التطبيق السبب التفصيلي في سجل المهمة.",
  };
}

/** Candidate URLs used by the probe and by the e2e suite (public, stable). */
export const YOUTUBE_PROBE_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

/** Tried in order by the e2e suite when the first one is bot-checked. */
export const YOUTUBE_FALLBACK_URLS = [
  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=9bZkp7q19f0",
];
