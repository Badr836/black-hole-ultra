/**
 * UI smoke check in a real browser (Playwright).
 *   npm start            # terminal 1
 *   npm run test:ui      # terminal 2
 * Fails on any console error or unhandled page error.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
mkdirSync("docs", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: "docs/screenshot-dashboard.png", fullPage: true });

// 1) HLS panel for a direct m3u8 link (no network call until "فحص").
await page.locator('input[inputmode="url"]').fill("https://example.com/live/master.m3u8");
await page.waitForTimeout(600);
const hlsPanel = await page.getByText("بث HLS مباشر").count();
const audioSelect = await page.locator("select").filter({ hasText: "تلقائي (أفضل مسار)" }).count();
const pageUrlField = await page.getByPlaceholder("https://example.com/watch/123").count();
await page.screenshot({ path: "docs/screenshot-hls-options.png", fullPage: true });

// 2) Settings panel: access-token management + HLS defaults.
await page.click('button[title="الإعدادات"]');
await page.waitForTimeout(1500);
const accessHeading = await page.getByText("أمان الوصول").count();
const rotateButton = await page.getByRole("button", { name: /تدوير/ }).count();
const autoHeaders = await page.getByText("استنتاج الترويسات تلقائياً").count();
await page.screenshot({ path: "docs/screenshot-settings.png", fullPage: true });

const title = await page.title();
const rows = await page.locator("li").count();
await browser.close();

console.log(`title: ${title}`);
console.log(`queue rows: ${rows}`);
console.log(`access section: ${accessHeading > 0 ? "✓" : "✗"} · rotate button: ${rotateButton > 0 ? "✓" : "✗"}`);
console.log(
  `HLS panel: ${hlsPanel > 0 ? "✓" : "✗"} · audio-language select: ${audioSelect > 0 ? "✓" : "✗"} · page-URL field: ${pageUrlField > 0 ? "✓" : "✗"}`,
);
console.log(`auto-header toggle: ${autoHeaders > 0 ? "✓" : "✗"}`);
if (accessHeading === 0 || rotateButton === 0 || hlsPanel === 0 || pageUrlField === 0 || autoHeaders === 0) {
  errors.push("new UI sections missing (access / HLS panel / auto-headers toggle)");
}
console.log(`console errors: ${errors.length}`);
for (const e of errors) console.log(`  ✗ ${e}`);
if (errors.length > 0) process.exit(1);
console.log("✓ UI smoke passed");
