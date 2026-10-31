"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * PWA plumbing + an explicit "install" affordance.
 *
 * Browsers differ, so all three real cases are handled:
 *   - Chromium (Chrome/Edge/Opera/Brave/Samsung): `beforeinstallprompt` fires and
 *     we keep the event to trigger the native dialog from our own button;
 *   - iOS Safari (no prompt at all): show the Share → "Add to Home Screen" hint;
 *   - already installed, or a browser without prompt support: the button hides.
 *
 * The service worker is registered here too — it is what makes the app
 * installable and lets it open without a network.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const media = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  // iOS Safari exposes a non-standard flag instead.
  const ios = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return media || ios;
}

function needsIosHint(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua);
  const safari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
  return (ios || safari) && !isStandalone();
}

/**
 * One external store for "is this running as an installed app?", so the effect
 * stays free of synchronous state writes (React's lint rule forbids those).
 */
function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia?.("(display-mode: standalone)");
  media?.addEventListener?.("change", onChange);
  window.addEventListener("appinstalled", onChange);
  return () => {
    media?.removeEventListener?.("change", onChange);
    window.removeEventListener("appinstalled", onChange);
  };
}

export default function PwaInstall() {
  const installed = useSyncExternalStore(subscribe, isStandalone, () => false);
  const iosHint = useSyncExternalStore(subscribe, needsIosHint, () => false);
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHintClosed, setIosHintClosed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [swState, setSwState] = useState<"idle" | "ready" | "error">("idle");

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        if (cancelled) return;
        // Pick up a new deployment without asking the user to clear anything.
        registration.addEventListener("updatefound", () => {
          registration.installing?.addEventListener("statechange", () => {
            if (registration.waiting) registration.waiting.postMessage("skip-waiting");
          });
        });
        setSwState("ready");
      })
      .catch(() => {
        if (!cancelled) setSwState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const install = useCallback(async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice?.outcome === "accepted") setPromptEvent(null);
    else setPromptEvent(null);
  }, [promptEvent]);

  if (installed || dismissed) {
    return (
      <span
        className="rounded-full border border-emerald-800/60 bg-emerald-950/30 px-3 py-1 text-[11px] text-emerald-300"
        title={swState === "ready" ? "التطبيق مثبّت ويعمل بلا اتصال" : "التطبيق مثبّت على هذا الجهاز"}
      >
        ✓ مثبَّت
      </span>
    );
  }

  // Nothing to offer: no native prompt and no iOS hint.
  if (!promptEvent && (!iosHint || iosHintClosed)) return null;

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      {promptEvent && (
        <button
          className="bh-btn bh-btn-primary text-xs"
          onClick={install}
          title="تثبيت التطبيق على هذا الجهاز — يعمل بعدها بلا متصفح"
        >
          ⬇ تثبيت التطبيق
        </button>
      )}
      {!promptEvent && iosHint && !iosHintClosed && (
        <button
          className="bh-btn bh-btn-ghost max-w-full whitespace-normal text-start text-xs leading-snug"
          onClick={() => setIosHintClosed(true)}
          title="من Safari: زر المشاركة ثم «إضافة إلى الشاشة الرئيسية»"
        >
          {/* على الشاشات الصغيرة يبقى زراً قصيراً بدل سطر كامل */}
          <span className="hidden sm:inline">📲 للتثبيت: مشاركة ← «إضافة إلى الشاشة الرئيسية»</span>
          <span className="sm:hidden">📲 تثبيت التطبيق</span>
        </button>
      )}
      <button
        className="text-[11px] text-[var(--muted)] underline-offset-2 hover:underline"
        onClick={() => setDismissed(true)}
        aria-label="إخفاء تلميح التثبيت"
      >
        ✕
      </button>
    </div>
  );
}
