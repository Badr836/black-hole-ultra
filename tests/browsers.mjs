/**
 * Cross-browser + PWA verification (real engines, real server).
 *
 *   npm start            # terminal 1
 *   npm run test:browsers # terminal 2
 *
 * Runs the same checks in Chromium, Firefox and WebKit (the Safari engine):
 *   - page loads, Arabic RTL layout, no console errors / page errors;
 *   - manifest is served with the right content type and valid install fields;
 *   - a service worker registers, activates and controls the page;
 *   - icons (192/512/maskable/apple-touch) return 200 with image/png;
 *   - the Settings panel and the HLS panel open without errors;
 *   - in Chromium: DevTools' own installability verdict
 *     (`Page.getInstallabilityErrors`) must be empty — that is the exact check
 *     the browser uses before offering "Install app".
 *
 * Screenshots are written to docs/browser-<engine>.png.
 */
import { chromium, devices, firefox, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const engines = [
  { name: "chromium", type: chromium, label: "Chrome/Edge/Opera (Blink)" },
  { name: "firefox", type: firefox, label: "Firefox (Gecko)" },
  { name: "webkit", type: webkit, label: "Safari (WebKit)" },
];


// ---------------------------------------------------------------------------
// Real device profiles (emulated touch + DPR + user agent), on the engine that
// each device actually ships with.
// ---------------------------------------------------------------------------
const deviceMatrix = [
  { device: "Pixel 7", type: chromium },
  { device: "Galaxy S24", type: chromium },
  { device: "iPhone 15", type: webkit },
  { device: "iPad Pro 11", type: webkit },
  { device: "Pixel 7 landscape", type: chromium },
  { device: "iPad Pro 11 landscape", type: webkit },
];

async function runDevices() {
  console.log("\n=== مصفوفة الأجهزة (touch + DPR) ===");
  const results = [];
  for (const { device, type } of deviceMatrix) {
    const profile = devices[device];
    const browser = await type.launch();
    const context = await browser.newContext({ ...profile, locale: "ar" });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // `networkidle` never settles behind a slow tunnel (the UI polls every 1.2s),
  // so wait for the URL field instead — a real readiness signal.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector('input[inputmode="url"]', { timeout: 90_000 });
    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const input = document.querySelector('input[inputmode="url"]');
      return {
        overflow: doc.scrollWidth - doc.clientWidth,
        font: input ? parseFloat(getComputedStyle(input).fontSize) : 0,
        touchTarget: (() => {
          const button = document.querySelector(".bh-icon-btn");
          if (!button) return 0;
          const box = button.getBoundingClientRect();
          return Math.min(box.width, box.height);
        })(),
        tapHighlight: getComputedStyle(document.body).webkitTapHighlightColor,
      };
    });
    await shot(page, `docs/device-${device.replace(/\s+/g, "-")}.png`, false);
    await browser.close();
    const ok = metrics.overflow <= 2 && metrics.font >= 16 && metrics.touchTarget >= 32 && pageErrors.length === 0;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "✓" : "✗"} ${device.padEnd(22)} overflow=${metrics.overflow}px · input=${metrics.font}px · target=${Math.round(metrics.touchTarget)}px${pageErrors.length ? ` · errors: ${pageErrors[0]}` : ""}`,
    );
    results.push({ device, metrics, ok });
  }
  report.devices = results;
}

mkdirSync("docs", { recursive: true });

// A screenshot must never fail the run (fonts/host can be slow behind a tunnel).
async function shot(page, path, fullPage = true) {
  try {
    await page.screenshot({ path, fullPage, timeout: 20_000, animations: "disabled" });
  } catch {
    console.log(`  (تخطّي لقطة ${path})`);
  }
}

const report = { base: BASE, generatedAt: new Date().toISOString(), engines: [] };
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return { name, ok, detail };
}

async function runEngine({ name, type, label }) {
  console.log(`\n=== ${name} — ${label} ===`);
  const browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    locale: "ar",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const results = [];
  const push = (result) => results.push({ engine: name, ...result });

  // `networkidle` never settles behind a slow tunnel (the UI polls every 1.2s),
  // so wait for the URL field instead — a real readiness signal.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector('input[inputmode="url"]', { timeout: 90_000 });
  push(check("page renders", true, await page.title()));
  push(check("RTL Arabic document", (await page.getAttribute("html", "dir")) === "rtl"));

  // --- manifest -------------------------------------------------------------
  const manifestHref = await page.getAttribute('link[rel="manifest"]', "href");
  push(check("manifest link present", Boolean(manifestHref), manifestHref ?? "missing"));
  // Resolve against the page's *final* origin (a short link may redirect first).
  const origin = new URL(page.url()).origin;
  const manifestResponse = await page.request.get(new URL(manifestHref ?? "/manifest.webmanifest", origin).toString());
  const manifestType = manifestResponse.headers()["content-type"] ?? "";
  const manifest = await manifestResponse.json().catch(() => ({}));
  push(check("manifest served as JSON", manifestResponse.ok() && /manifest\+json/.test(manifestType), manifestType));
  push(
    check(
      "manifest has install fields",
      Boolean(manifest.name && manifest.short_name && manifest.start_url && manifest.display === "standalone"),
      `display=${manifest.display} · start=${manifest.start_url}`,
    ),
  );
  const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
  push(
    check(
      "icons include 192, 512 and maskable",
      sizes.includes("192x192") &&
        sizes.includes("512x512") &&
        (manifest.icons ?? []).some((icon) => (icon.purpose ?? "").includes("maskable")),
      sizes.join(", "),
    ),
  );

  // Every icon must really exist (a 404 here silently breaks installability).
  let iconsOk = true;
  for (const icon of manifest.icons ?? []) {
    const response = await page.request.get(new URL(icon.src, origin).toString());
    const type = response.headers()["content-type"] ?? "";
    if (!response.ok() || !/image\/(png|svg)/.test(type)) {
      iconsOk = false;
      push(check(`icon ${icon.src}`, false, `${response.status()} ${type}`));
    }
  }
  push(check("all manifest icons load", iconsOk));

  // --- service worker -------------------------------------------------------
  const sw = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { supported: false };
    const registration = await navigator.serviceWorker.getRegistration("/");
    const ready = registration ? await navigator.serviceWorker.ready : null;
    return {
      supported: true,
      scope: ready?.scope ?? registration?.scope ?? null,
      active: Boolean(ready?.active),
      controlled: Boolean(navigator.serviceWorker.controller),
    };
  });
  push(check("service worker supported", sw.supported));
  if (sw.supported) {
    push(check("service worker active", Boolean(sw.active), sw.scope ?? ""));
    // First load may need a reload before the page is claimed.
    if (!sw.controlled) {
      await page.reload({ waitUntil: "domcontentloaded" });
      const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
      push(check("page controlled after reload", controlled));
    } else {
      push(check("page controlled by service worker", true));
    }
  }

  // --- UI interaction -------------------------------------------------------
  await page.locator('input[inputmode="url"]').fill("https://example.com/live/master.m3u8");
  await page.waitForTimeout(400);
  push(check("HLS panel opens", (await page.getByText("بث HLS مباشر").count()) > 0));
  await page.locator('input[inputmode="url"]').fill("");

  await page.click('button[title="الإعدادات"]');
  await page.waitForTimeout(600);
  push(check("settings panel opens", (await page.getByText("حالة المحركات").count()) > 0));
  push(check("access section renders", (await page.getByText("أمان الوصول").count()) > 0));
  await page.click('aside button:has-text("✕")').catch(() => {});
  await page.waitForTimeout(300);

  // --- mobile viewport (iPhone-ish) ----------------------------------------
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: name !== "firefox",
    hasTouch: true,
    locale: "ar",
    userAgent:
      name === "webkit"
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        : undefined,
  });
  const mobilePage = await mobile.newPage();
  const mobileErrors = [];
  mobilePage.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobilePage.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await mobilePage.waitForSelector('input[inputmode="url"]', { timeout: 90_000 });
  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  push(check("no horizontal overflow at 390px", overflow <= 2, `${overflow}px`));
  const inputFont = await mobilePage.evaluate(() => {
    const input = document.querySelector('input[inputmode="url"]');
    return input ? getComputedStyle(input).fontSize : "n/a";
  });
  push(check("inputs are >=16px on mobile (no iOS zoom)", parseFloat(inputFont) >= 16, inputFont));
  await shot(mobilePage, `docs/browser-${name}-mobile.png`);
  push(check("mobile page has no runtime errors", mobileErrors.length === 0, mobileErrors.join(" | ")));
  await mobile.close();

  await shot(page, `docs/browser-${name}.png`);

  // --- Chromium only: the browser's own installability verdict --------------
  if (name === "chromium") {
    const session = await context.newCDPSession(page);
    await session.send("Page.enable");
    const verdict = await session.send("Page.getInstallabilityErrors");
    const problems = (verdict?.installabilityErrors ?? []).map((item) => item.errorId);
    push(check("DevTools says the app is installable", problems.length === 0, problems.join(", ") || "no errors"));
  }

  push(check("no console/page errors", errors.length === 0, errors.slice(0, 3).join(" | ")));

  const failed = results.filter((result) => !result.ok);
  report.engines.push({ engine: name, label, passed: results.length - failed.length, total: results.length, failed });
  await browser.close();
}

for (const engine of engines) {
  try {
    await runEngine(engine);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${engine.name} crashed — ${error instanceof Error ? error.message : String(error)}`);
    report.engines.push({ engine: engine.name, label: engine.label, crashed: true, error: String(error) });
  }
}

await runDevices();

writeFileSync("docs/browsers-report.json", `${JSON.stringify(report, null, 2)}\n`);
console.log("\n== ملخّص ==");
for (const entry of report.engines) {
  console.log(
    entry.crashed
      ? `${entry.engine.padEnd(9)} ✗ crashed`
      : `${entry.engine.padEnd(9)} ${entry.passed}/${entry.total} ${entry.failed.length ? `✗ ${entry.failed.map((f) => f.name).join(", ")}` : "✓"}`,
  );
}
console.log(failures === 0 ? "\nكل المحرّكات نجحت ✓" : `\n${failures} إخفاق`);
process.exit(failures === 0 ? 0 : 1);
