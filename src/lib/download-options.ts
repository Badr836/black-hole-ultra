import type { Settings } from "@/db/schema";

/** Common resilience and optional authentication options for yt-dlp. */
export function commonDownloadOptions(settings: Settings): string[] {
  const args = [
    "--socket-timeout",
    "30",
    "--extractor-retries",
    "3",
    "--file-access-retries",
    "3",
  ];
  if (settings.cookiesPath?.trim()) {
    args.push("--cookies", settings.cookiesPath.trim());
  } else if (settings.cookiesFromBrowser?.trim()) {
    args.push("--cookies-from-browser", settings.cookiesFromBrowser.trim());
  }
  return args;
}
