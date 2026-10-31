/**
 * Session headers for protected HLS links (Referer / Origin).
 *
 * The gap this closes: the previous round required the user to paste
 * `Referer: …` by hand, because "the app cannot know the page". That is only
 * half true — there are three cheap, honest candidates, and a HEAD/GET probe on
 * the manifest tells us which one the CDN actually accepts:
 *
 *   1. `user`   — whatever the user typed in the settings (always first, wins);
 *   2. `page`   — the watch page URL, when the user gave us one for this job;
 *   3. `origin` — `Referer: <manifest origin>`: many hotlink guards only reject
 *                 *missing* referers and accept a same-origin one.
 *
 * Plus the cookies that already come from `cookies.txt`. We never invent a
 * different site's domain as a referer — that would be a fake anti-hotlink
 * bypass, and it is not implemented.
 *
 * No DRM, no signature forging: only headers the browser itself would send.
 */

export type HeaderCandidate = {
  /** user | page | origin — shown in the job log so the choice is inspectable. */
  label: "user" | "page" | "origin";
  headers: Record<string, string>;
  /** Arabic one-liner used in logs/diagnostics. */
  note: string;
};

export function originOf(url: string | null | undefined): string | null {
  try {
    const parsed = new URL(String(url));
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** A watch page must be http(s) and should not be the manifest itself. */
function cleanPageUrl(pageUrl: string | null | undefined): string | null {
  const value = (pageUrl ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Ordered candidates. Duplicates (same Referer) are collapsed, so the probe runs
 * at most three times.
 */
export function buildHeaderCandidates(input: {
  userHeaders?: Record<string, string> | null;
  pageUrl?: string | null;
  manifestUrl: string;
  /** Set to false to disable the automatic ones (user asked for "headers only"). */
  auto?: boolean;
}): HeaderCandidate[] {
  const candidates: HeaderCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: HeaderCandidate) => {
    const signature = JSON.stringify(
      Object.entries(candidate.headers)
        .map(([key, value]) => [key.toLowerCase(), value])
        .sort(),
    );
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push(candidate);
  };

  const user = Object.fromEntries(
    Object.entries(input.userHeaders ?? {}).filter(([key, value]) => key && value && !/[\r\n]/.test(key + value)),
  );
  if (Object.keys(user).length > 0) {
    push({ label: "user", headers: user, note: "ترويسات المستخدم من الإعدادات" });
  }

  if (input.auto === false) return candidates;

  const page = cleanPageUrl(input.pageUrl);
  if (page) {
    const origin = originOf(page);
    push({
      label: "page",
      headers: { Referer: page, ...(origin ? { Origin: origin } : {}) },
      note: `Referer من صفحة المشاهدة: ${page}`,
    });
  }

  const manifestOrigin = originOf(input.manifestUrl);
  // When the watch page already lives on the stream's own origin, the
  // same-origin candidate adds nothing but an extra probe.
  const pageOrigin = originOf(page);
  if (manifestOrigin && pageOrigin !== manifestOrigin) {
    push({
      label: "origin",
      headers: { Referer: `${manifestOrigin}/`, Origin: manifestOrigin },
      note: `Referer من نطاق البث نفسه: ${manifestOrigin}`,
    });
  }

  return candidates;
}

export type ManifestProbeResult = {
  /** Candidate that answered with a 2xx, if any. */
  chosen: HeaderCandidate | null;
  /** Status per candidate, for the log ("user→403, page→200"). */
  attempts: { label: string; status: number | null; error?: string }[];
};

export type Probe = (url: string, headers: Record<string, string>) => Promise<number>;

/** Default probe: a bounded GET that only reads the first bytes of the manifest. */
export const fetchProbe: Probe = async (url, headers) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "BlackHoleUltra/1.0", ...headers },
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
    });
    // Drain a little so the connection can be reused, then drop the body.
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    return response.status;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Probe the candidates in order and keep the first 2xx. When nothing answers
 * 2xx we still return the first candidate, so the engine's own error handling
 * (and its Arabic explanation) stays in charge.
 */
export async function pickWorkingHeaders(
  candidates: HeaderCandidate[],
  manifestUrl: string,
  probe: Probe = fetchProbe,
): Promise<ManifestProbeResult> {
  const attempts: ManifestProbeResult["attempts"] = [];
  for (const candidate of candidates) {
    try {
      const status = await probe(manifestUrl, candidate.headers);
      attempts.push({ label: candidate.label, status });
      if (status >= 200 && status < 300) return { chosen: candidate, attempts };
    } catch (error) {
      attempts.push({
        label: candidate.label,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { chosen: candidates[0] ?? null, attempts };
}

/** Human-readable trace for the job log. */
export function describeProbe(result: ManifestProbeResult): string {
  const parts = result.attempts.map((attempt) =>
    attempt.status === null ? `${attempt.label}→فشل شبكي` : `${attempt.label}→${attempt.status}`,
  );
  const chosen = result.chosen ? `اختير: ${result.chosen.label}` : "لا مرشح";
  return `فحص الترويسات (${parts.join("، ") || "بلا مرشحات"}) · ${chosen}`;
}
