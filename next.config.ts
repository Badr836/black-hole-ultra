import type { NextConfig } from "next";
import { resolveAccessToken } from "./src/lib/access-token";

/**
 * LAN hardening: when the server binds to a public address and no token was
 * configured, generate one and expose it through `process.env` so the
 * middleware (edge runtime) can enforce it. This runs once per `next start`.
 */
const resolved = resolveAccessToken();
if (resolved.token && !process.env.BLACKHOLE_TOKEN) {
  process.env.BLACKHOLE_TOKEN = resolved.token;
}
if (resolved.token && resolved.source === "generated") {
  console.log(
    `\n[blackhole] تم توليد رمز وصول للشبكة المحلية وحفظه في:\n  ${resolved.file}\n` +
      `افتح التطبيق من جهاز آخر بـ: http://<عنوان-هذا-الجهاز>:3000/?token=<الرمز>\n` +
      `لتعطيله: BLACKHOLE_AUTO_TOKEN=0 — أو استخدم رمزك: BLACKHOLE_TOKEN=...\n`,
  );
}

const nextConfig: NextConfig = {};

export default nextConfig;
