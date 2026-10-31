import type { MetadataRoute } from "next";

/**
 * PWA manifest (served at /manifest.webmanifest).
 *
 * Installability requirements handled here:
 *   - `start_url` + `scope` so the installed window opens the app, not a deep link;
 *   - 192px and 512px icons **plus** a 512px `maskable` icon (Android needs it,
 *     otherwise it shows a white square);
 *   - `display: standalone` (no browser chrome) with `display_override` for
 *     browsers that support window controls overlay / minimal-ui;
 *   - `dir: rtl` + `lang: ar` so the Arabic UI is laid out correctly when launched
 *     from the home screen.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BlackHole Ultra Downloader",
    short_name: "BlackHole",
    description:
      "مدير تحميل محلي سريع يعتمد على yt-dlp و FFmpeg — بدون إعلانات أو تتبع. يعمل على جهازك.",
    id: "/",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#050308",
    theme_color: "#050308",
    lang: "ar",
    dir: "rtl",
    categories: ["utilities", "productivity"],
    prefer_related_applications: false,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "لصق رابط وتحميل",
        short_name: "تحميل سريع",
        url: "/?action=paste",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "قائمة التحميلات",
        short_name: "التحميلات",
        url: "/?focus=queue",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
