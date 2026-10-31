/**
 * Access control decisions (pure, edge-safe).
 *
 * The app binds to `0.0.0.0` in Docker/LAN/preview environments, which used to
 * mean "anyone on the same network can queue downloads on your machine". The
 * rule implemented here:
 *
 *   - loopback (`127.0.0.1`, `localhost`, `[::1]`) → always allowed, no friction;
 *   - hosted preview proxies (`*.e2b.app`, `*.vercel.app`, …) → allowed, because
 *     they cannot carry a custom token and are already isolated per sandbox;
 *   - anything else (a real LAN IP / hostname) → a token is required;
 *   - `BLACKHOLE_ALLOW_UNAUTHENTICATED=1` disables the requirement explicitly.
 *
 * Kept free of node:fs so the Next middleware (edge runtime) can import it.
 */

export const TOKEN_HEADER = "x-blackhole-token";
export const TOKEN_COOKIE = "blackhole_token";

/** Hosts that are "the same machine" — a token there is pure friction. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  const value = (host ?? "").toLowerCase().replace(/:\d+$/, "").trim();
  if (!value) return false;
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  if (value === "[::1]" || value === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * Hosted preview domains. These proxies rewrite `Host` and cannot forward a
 * custom header, so requiring a token there would make the app unusable.
 */
export const PREVIEW_HOST_PATTERNS: RegExp[] = [
  /\.e2b\.app$/i,
  /\.e2b\.dev$/i,
  /\.vercel\.app$/i,
  /\.netlify\.app$/i,
  /\.ngrok(-free)?\.app$/i,
  /\.trycloudflare\.com$/i,
  /\.githubpreview\.dev$/i,
  // أنفاق HTTPS بلا حساب (تُبدّل Host ولا تستطيع تمرير رأس مخصّص):
  /\.lhr\.life$/i, //          localhost.run
  /\.loca\.lt$/i, //           localtunnel
  /\.pinggy\.link$/i, //       pinggy.io
  /\.serveo\.net$/i, //        serveo
  /\.tunnelmole\.net$/i, //    tunnelmole
  /\.ngrok\.io$/i, //          ngrok (النطاق القديم)
  /\.ts\.net$/i, //           Tailscale (شبكة خاصة بالفعل + شهادة HTTPS صالحة)
];

export function isPreviewHost(host: string | null | undefined): boolean {
  const value = (host ?? "").toLowerCase().replace(/:\d+$/, "").trim();
  if (!value) return false;
  return PREVIEW_HOST_PATTERNS.some((pattern) => pattern.test(value));
}

export type AccessDecision = {
  requireToken: boolean;
  /** Why, in one Arabic sentence — surfaced in 401 responses and diagnostics. */
  reason: string;
};

export function decideAccess(input: {
  host: string | null | undefined;
  hasConfiguredToken: boolean;
  allowUnauthenticated?: boolean;
}): AccessDecision {
  const { host, hasConfiguredToken } = input;
  if (input.allowUnauthenticated) {
    return { requireToken: false, reason: "الوصول المفتوح مُفعّل صراحةً (BLACKHOLE_ALLOW_UNAUTHENTICATED=1)." };
  }
  if (!hasConfiguredToken) {
    return { requireToken: false, reason: "لا يوجد رمز وصول مُهيّأ." };
  }
  if (isLoopbackHost(host)) {
    return { requireToken: false, reason: "طلب من الجهاز نفسه (loopback) — لا حاجة لرمز." };
  }
  if (isPreviewHost(host)) {
    return { requireToken: false, reason: "مضيف معاينة مستضاف (معزول بالفعل) — لا حاجة لرمز." };
  }
  return {
    requireToken: true,
    reason: "الوصول من الشبكة يتطلب رمز وصول (BLACKHOLE_TOKEN أو data/access-token.txt).",
  };
}

/** Constant-ish-time comparison; the token is short so this is about hygiene. */
export function tokenEquals(provided: string | null | undefined, expected: string | null | undefined): boolean {
  const a = (provided ?? "").trim();
  const b = (expected ?? "").trim();
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Where a client may present the token (first non-empty wins). */
export function extractToken(input: {
  header?: string | null;
  cookie?: string | null;
  query?: string | null;
}): string | null {
  for (const candidate of [input.header, input.cookie, input.query]) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return null;
}
