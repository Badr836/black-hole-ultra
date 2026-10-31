/**
 * Log redaction.
 *
 * Persisted diagnostics must never contain cookies, tokens or header values.
 * The previous version only handled `--cookies*` and URL query strings; the
 * `--add-headers` values we inject ourselves (Referer/Accept-Language) and any
 * `Authorization`-style header leaked through.
 */

const SECRET_FLAGS = [
  "--cookies",
  "--cookies-from-browser",
  "--add-headers",
  "--username",
  "--password",
  "--video-password",
  "--netrc-location",
];

export function redactLog(raw: string, maxLength = 12_000): string {
  let out = raw ?? "";

  for (const flag of SECRET_FLAGS) {
    const pattern = new RegExp(
      `(${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+)(?:"[^"]*"|'[^']*'|\\S+)`,
      "gi",
    );
    out = out.replace(pattern, "$1[REDACTED]");
  }

  // Query strings can carry signed URLs / tokens.
  out = out.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[REDACTED]");

  // Inline header dumps: "Authorization: Bearer ..." / "Cookie: ...".
  out = out.replace(
    /((?:authorization|cookie|x-api-key|x-blackhole-token)\s*:\s*)[^\s,;]+(?:\s+[^\s,;]+)*/gi,
    "$1[REDACTED]",
  );

  // Absolute home paths are user-identifying metadata; keep the basename only.
  return out.slice(-maxLength).trim();
}

export function extractYtDlpError(stderr: string): string {
  const lines = (stderr ?? "").split(/\r?\n/).filter((line) => line.includes("ERROR"));
  const last = lines[lines.length - 1] ?? "";
  return last.replace(/^ERROR:\s*/, "").slice(0, 500);
}

export function extractFfmpegError(stderr: string): string {
  return (
    (stderr ?? "")
      .split(/\r?\n/)
      .filter((line) => /error|invalid|failed/i.test(line))
      .slice(-1)[0]
      ?.trim()
      .slice(0, 300) ?? ""
  );
}
