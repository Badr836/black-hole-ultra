/**
 * Provider routing.
 *
 * The app used to be "yt-dlp only". yt-dlp is unbeatable for video platforms,
 * but it refuses (or returns nothing for) media that is not a "video page":
 * Instagram photo/reel posts, X/Twitter media tweets, Pinterest, Pixiv,
 * galleries in general. `gallery-dl` (mikf/gallery-dl, GPL-2.0, 20k★) is the
 * reference tool for exactly those. Instead of guessing, we route per URL and
 * fall back automatically when one engine cannot handle the link.
 *
 * This module is pure (no child processes, no DB) so it is unit-testable.
 */

export type ProviderId = "ytdlp" | "gallerydl" | "nm3u8dl";

export type ProviderAvailability = { ytdlp: boolean; gallerydl: boolean; nm3u8dl?: boolean };

export type RouteResult = {
  provider: ProviderId;
  /** Why this provider was chosen (shown in the UI / diagnostics). */
  reason: string;
  /** The other provider, used when the first one fails with a known gap. */
  fallback: ProviderId | null;
};

/**
 * Hosts where gallery-dl is the better first choice: media galleries and posts
 * that are not a single video page.
 */
const GALLERY_HOSTS: { pattern: RegExp; label: string }[] = [
  { pattern: /(^|\.)instagram\.com$/i, label: "Instagram (منشورات/ريلز وصور)" },
  { pattern: /(^|\.)instagr\.am$/i, label: "Instagram" },
  { pattern: /(^|\.)(twitter|x)\.com$/i, label: "X / Twitter (وسائط التغريدة)" },
  { pattern: /(^|\.)pinterest\.[a-z.]+$/i, label: "Pinterest" },
  { pattern: /(^|\.)pixiv\.net$/i, label: "Pixiv" },
  { pattern: /(^|\.)deviantart\.com$/i, label: "DeviantArt" },
  { pattern: /(^|\.)flickr\.com$/i, label: "Flickr" },
  { pattern: /(^|\.)tumblr\.com$/i, label: "Tumblr" },
  { pattern: /(^|\.)bunkr\.[a-z.]+$/i, label: "Bunkr" },
  { pattern: /(^|\.)danbooru\.donmai\.us$/i, label: "Danbooru" },
  { pattern: /(^|\.)reddit\.com$/i, label: "Reddit (صور/معارض)" },
  { pattern: /(^|\.)redd\.it$/i, label: "Reddit" },
];

export function galleryHostLabel(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return GALLERY_HOSTS.find((entry) => entry.pattern.test(host))?.label ?? null;
  } catch {
    return null;
  }
}

/** An explicit user choice always wins ("auto" means: decide from the URL). */
export function routeProvider(
  url: string,
  availability: ProviderAvailability,
  preference: "auto" | ProviderId = "auto",
): RouteResult {
  const label = galleryHostLabel(url);
  const usable = (id: ProviderId): boolean =>
    id === "ytdlp" ? availability.ytdlp : id === "gallerydl" ? availability.gallerydl : Boolean(availability.nm3u8dl);
  const other = (id: ProviderId): ProviderId | null => {
    // HLS engine falls back to yt-dlp; yt-dlp falls back to gallery-dl.
    const candidates: ProviderId[] =
      id === "ytdlp" ? ["gallerydl", "nm3u8dl"] : id === "nm3u8dl" ? ["ytdlp"] : ["ytdlp"];
    return candidates.find(usable) ?? null;
  };

  const want: ProviderId =
    preference !== "auto" ? preference : label && availability.gallerydl ? "gallerydl" : "ytdlp";

  // A gallery-style URL without gallery-dl installed: be explicit, because
  // yt-dlp will very likely fail on it and the user deserves the real reason.
  if (preference === "auto" && label && !availability.gallerydl && availability.ytdlp) {
    return {
      provider: "ytdlp",
      reason: `${label}: gallery-dl غير مثبّت — ستُجرَّب yt-dlp وقد تفشل.`,
      fallback: null,
    };
  }

  if (want === "gallerydl" && !availability.gallerydl) {
    return {
      provider: "ytdlp",
      reason: label
        ? `${label}: gallery-dl غير مثبّت — ستُجرَّب yt-dlp وقد تفشل.`
        : "gallery-dl غير مثبّت — استخدام yt-dlp.",
      fallback: null,
    };
  }
  if (want === "nm3u8dl" && !availability.nm3u8dl) {
    return {
      provider: "ytdlp",
      reason: "N_m3u8DL-RE غير مثبّت — استخدام yt-dlp لهذا الرابط.",
      fallback: null,
    };
  }
  if (want === "ytdlp" && !availability.ytdlp) {
    return {
      provider: "gallerydl",
      reason: "yt-dlp غير مثبّت — استخدام gallery-dl.",
      fallback: null,
    };
  }

  return {
    provider: want,
    reason:
      want === "gallerydl"
        ? `${label ?? "الموقع"} → gallery-dl (المزوّد المناسب لوسائط المنشورات)`
        : want === "nm3u8dl"
          ? "N_m3u8DL-RE (مزوّد HLS المحمي بجلسة)"
          : "yt-dlp (المزوّد العام للفيديو)",
    fallback: other(want),
  };
}

/**
 * Errors that mean "this engine cannot handle the link at all", where retrying
 * with the other engine is genuinely useful (and not just a transient failure).
 */
const GAP_PATTERNS = [
  /no video could be found/i,
  /unsupported url/i,
  /empty media response/i,
  /there is no video/i,
  /unable to extract/i,
  /no suitable info found/i,
  /no image\/video/i,
];

/**
 * Rate limiting is not an engine problem: both engines just sleep and retry, so
 * the job looks alive while nothing happens. Detect it and stop immediately.
 */
export function isRateLimitMessage(text: string): boolean {
  return /429 Too Many Requests|HTTP Error 429|rate.?limit/i.test(text ?? "");
}

export function shouldTryFallback(error: string): boolean {
  const text = error ?? "";
  if (/account authentication|login required|rate-limit|429|sign in/i.test(text)) return false;
  return GAP_PATTERNS.some((pattern) => pattern.test(text));
}

/** Human explanation for platforms where the engine is not the real problem. */
export function platformHint(url: string): string | null {
  const label = galleryHostLabel(url);
  if (!label) return null;
  if (/instagram/i.test(label)) {
    return "إنستغرام يرفض الزيارات غير المسجّلة منذ 2024. أضف كوكيز جلستك من الإعدادات (استيراد من المتصفح) — هذا هو الحل الوحيد المشروع، وهو ما تفعله كل الأدوات العاملة اليوم.";
  }
  if (/reddit/i.test(label)) {
    return "ريديت يطلب مصادقة لبعض المحتوى. أضف كوكيز من الإعدادات لتفعيل التحميل.";
  }
  if (/twitter|x \//i.test(label)) {
    return "X/Twitter يخفي الوسائط عن الزوار غير المسجّلين في كثير من الحالات. الكوكيز ترفع نسبة النجاح كثيراً.";
  }
  return null;
}
