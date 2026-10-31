import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.BLACKHOLE_PUBLIC_URL ?? "http://localhost:3000"),
  title: {
    default: "BlackHole Ultra Downloader",
    template: "%s · BlackHole Ultra",
  },
  description:
    "مدير تحميل محلي قوي يعتمد على yt-dlp و FFmpeg — بدون إعلانات، بدون تتبع.",
  applicationName: "BlackHole Ultra Downloader",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: ["/favicon.ico"],
  },
  // iOS ignores the manifest for "Add to Home Screen" behaviour; these do the work.
  appleWebApp: {
    capable: true,
    title: "BlackHole",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false, email: false, address: false },
  other: {
    // Legacy Android/Chrome and Windows tiles.
    "mobile-web-app-capable": "yes",
    "msapplication-TileColor": "#050308",
    "msapplication-TileImage": "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#050308" },
    { media: "(prefers-color-scheme: light)", color: "#050308" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="antialiased">{children}</body>
    </html>
  );
}
