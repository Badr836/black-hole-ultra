/**
 * BlackHole Ultra — service worker.
 *
 * Goals, in order:
 *   1. make the app installable (a registered SW + manifest is what browsers
 *      require) and open instantly from the home screen;
 *   2. keep the *download engine* alone: every `/api/*` request goes to the
 *      network untouched — a cached queue would show stale progress and, worse,
 *      stale controls;
 *   3. survive a killed network (offline shell) without ever caching an
 *      authentication failure page.
 *
 * Versioned cache: bump CACHE when the shell changes.
 */
const CACHE = "blackhole-shell-v1";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individual requests so a LAN 401 (token not yet supplied) cannot abort
      // the whole install — the SW must still become active for the PWA to work.
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "reload" });
            if (response.ok) await cache.put(url, response.clone());
          } catch {
            /* offline during install: the shell fills in on first successful visit */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/** Only same-origin, successful, non-API responses are worth caching. */
function cacheable(request, response) {
  if (!response || response.status !== 200) return false;
  if (response.redirected) return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The engine and its state are always live.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network first, cached shell as the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (cacheable(request, response)) {
            const cache = await caches.open(CACHE);
            await cache.put("/", response.clone());
          }
          return response;
        } catch {
          const cache = await caches.open(CACHE);
          const cached = (await cache.match(request)) || (await cache.match("/"));
          if (cached) return cached;
          return new Response(
            "<!doctype html><html lang=\"ar\" dir=\"rtl\"><meta charset=\"utf-8\"><title>بلا اتصال</title>" +
              "<body style=\"font-family:system-ui;background:#050308;color:#ece6f7;padding:40px;text-align:center\">" +
              "<h1>لا يوجد اتصال</h1><p>الخادم المحلي غير متاح الآن. أعد المحاولة بعد لحظات.</p></body></html>",
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
      })(),
    );
    return;
  }

  // Static assets: cache first, then refresh in the background.
  const isStatic =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    /\.(?:css|js|png|jpg|jpeg|svg|webp|woff2?|ico)$/i.test(url.pathname);

  if (isStatic) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        if (cached) {
          event.waitUntil(
            (async () => {
              try {
                const fresh = await fetch(request);
                if (cacheable(request, fresh)) await cache.put(request, fresh.clone());
              } catch {
                /* keep the cached copy */
              }
            })(),
          );
          return cached;
        }
        const response = await fetch(request);
        if (cacheable(request, response)) await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});

/** Let the page ask the SW to take over after a fresh deployment. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
