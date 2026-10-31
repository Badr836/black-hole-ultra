import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, extractToken, TOKEN_COOKIE, TOKEN_HEADER, tokenEquals } from "@/lib/access";

/**
 * Access guard.
 *
 * Until now the only protection was an *optional* `BLACKHOLE_TOKEN`, and the app
 * binds to `0.0.0.0` in Docker/LAN/preview — i.e. open to the whole network by
 * default. Now:
 *
 *   - a token is auto-generated at boot for public binds (see next.config.ts);
 *   - it is required for non-loopback, non-preview hosts;
 *   - `?token=…` on first visit sets an HttpOnly cookie so the UI just works;
 *   - loopback and hosted previews stay friction-free.
 *
 * `BLACKHOLE_STRICT_ORIGIN=1` still adds the Origin/Host check for mutating calls.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function deny(message: string, status: number, extra?: Record<string, unknown>) {
  const wantsHtml = message.startsWith("html:");
  if (wantsHtml) {
    const body = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8">
<title>رمز الوصول مطلوب</title>
<body style="font-family:system-ui;background:#0b0616;color:#eee;padding:40px;line-height:1.9">
<h1 style="color:#a78bfa">رمز الوصول مطلوب</h1>
<p>${message.replace(/^html:/, "")}</p>
<p style="opacity:.7">افتح الرابط مع الرمز: <code dir="ltr">/?token=الرمز</code></p>
</body></html>`;
    return new NextResponse(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8", ...(extra as Record<string, string>) },
    });
  }
  return NextResponse.json({ error: message, ...extra }, { status });
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const isPage = pathname === "/";

  if (!isApi && !isPage) return NextResponse.next();
  if (pathname === "/api/health" || pathname === "/api/access/verify") return NextResponse.next();

  // Boot value from next.config.ts. The edge runtime cannot read the token file,
  // so a rotated token is verified by a Node endpoint (see below).
  const expected = process.env.BLACKHOLE_TOKEN?.trim() ?? "";
  const decision = decideAccess({
    host: req.headers.get("host"),
    hasConfiguredToken: Boolean(expected),
    allowUnauthenticated: process.env.BLACKHOLE_ALLOW_UNAUTHENTICATED === "1",
  });

  if (decision.requireToken) {
    const queryToken = req.nextUrl.searchParams.get("token");
    const provided = extractToken({
      header: req.headers.get(TOKEN_HEADER),
      cookie: req.cookies.get(TOKEN_COOKIE)?.value,
      query: queryToken,
    });

    // Authoritative check. The edge runtime keeps the boot-time token, so a
    // rotation performed at runtime must be verified by the Node runtime —
    // otherwise the *old* token would stay valid (it did, before this change).
    const verdict = await verifyToken(req, provided);
    if (verdict !== "ok") {
      return deny(
        isApi
          ? decision.reason
          : `html:${decision.reason} الرمز محفوظ في الملف data/access-token.txt على جهاز الخادم.`,
        401,
      );
    }

    // First successful visit with ?token=… → remember it in a cookie.
    if (queryToken && tokenEquals(queryToken, provided) && isPage) {
      const response = NextResponse.next();
      response.cookies.set(TOKEN_COOKIE, provided as string, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
      return response;
    }
  }

  if (process.env.BLACKHOLE_STRICT_ORIGIN === "1" && MUTATING.has(req.method)) {
    const origin = req.headers.get("origin");
    if (origin) {
      const host = req.headers.get("host") ?? "";
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = "";
      }
      if (!originHost || originHost !== host) {
        return NextResponse.json({ error: "طلب عبر-الأصل مرفوض." }, { status: 403 });
      }
    }
  }

  return NextResponse.next();
}

/**
 * Ask the Node runtime whether `token` is the *current* token.
 *
 * Background: `POST /api/access` rotates the token at runtime. The edge
 * middleware keeps the boot-time value (verified: after a rotation the old token
 * still returned 200 and the new one 401), and it cannot read the file. One
 * loopback call to a Node route is enough to make rotation immediate; the route
 * is excluded from this middleware, so there is no recursion.
 */
async function verifyToken(req: NextRequest, token: string | null): Promise<"ok" | "no" | "unavailable"> {
  const expected = process.env.BLACKHOLE_TOKEN?.trim() ?? "";
  if (!token) return "no";
  // Fast path: the boot token is always valid unless it has been rotated, and a
  // rotation is only observable through the Node runtime — so ask it first.
  try {
    const target = new URL("/api/access/verify", req.nextUrl.origin);
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
    if (!response.ok) return "no";
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true ? "ok" : "no";
  } catch {
    // The Node runtime is unreachable (should not happen): fall back to the boot
    // value so the app stays usable rather than locking the owner out.
    return tokenEquals(token, expected) ? "ok" : "unavailable";
  }
}

export const config = { matcher: ["/", "/api/:path*"] };
