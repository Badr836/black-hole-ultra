"use client";

import PwaInstall from "./PwaInstall";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import AddDownload from "./AddDownload";
import DownloadQueue from "./DownloadQueue";
import MediaPlayer from "./MediaPlayer";
import SettingsPanel from "./SettingsPanel";
import { api, fmtBytes, type DownloadItem, type LibraryStats, type SystemInfo } from "./types";

// ---------------------------------------------------------------------------
// Notifications button.
// Asking for the permission *automatically* on load is rejected by Firefox and
// Safari ("must be requested from a user gesture"), and Chrome down-ranks it.
// So the permission is only ever requested from this explicit click, and the
// resulting state is mirrored into a tiny store the button subscribes to.
// ---------------------------------------------------------------------------
const notifyListeners = new Set<() => void>();

function subscribeNotify(onChange: () => void) {
  notifyListeners.add(onChange);
  const onVisible = () => {
    if (document.visibilityState === "visible") onChange();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onChange);
  return () => {
    notifyListeners.delete(onChange);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onChange);
  };
}

function notifySnapshot(): string {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function NotifyButton() {
  const permission = useSyncExternalStore(subscribeNotify, notifySnapshot, () => "unsupported");
  if (permission === "unsupported") return null;

  const title =
    permission === "granted"
      ? "تنبيهات سطح المكتب مفعّلة — اضغط لإيقافها من إعدادات الموقع"
      : permission === "denied"
        ? "المتصفح يمنع التنبيهات — اسمح بها من أيقونة القفل في شريط العنوان"
        : "تفعيل تنبيه عند اكتمال أو فشل التحميل";

  async function toggle() {
    if (permission === "granted" || permission === "denied") {
      alert(
        permission === "granted"
          ? "التنبيهات مفعّلة. لإيقافها افتح إعدادات الموقع من أيقونة القفل/الشرائط بجانب العنوان واختر «منع» للتنبيهات."
          : "المتصفح يمنع التنبيهات لهذا الموقع. اسمح بها من أيقونة القفل في شريط العنوان ثم أعد المحاولة.",
      );
      return;
    }
    try {
      await Notification.requestPermission();
    } catch {
      /* بعض المتصفحات ترفض الطلب بلا إيماءة — لا شيء نخسره */
    }
    notifyListeners.forEach((listener) => listener());
  }

  return (
    <button
      className="bh-icon-btn"
      onClick={toggle}
      title={title}
      aria-label={title}
      aria-pressed={permission === "granted"}
      style={permission === "granted" ? undefined : { opacity: 0.6 }}
    >
      {permission === "granted" ? "🔔" : permission === "denied" ? "🔕" : "🔔"}
    </button>
  );
}

export default function Dashboard() {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [playing, setPlaying] = useState<DownloadItem | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const prevStatus = useRef<Map<number, string>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ items: DownloadItem[]; stats?: LibraryStats }>("/api/downloads");
      // Notifications on completion / failure
      for (const d of r.items) {
        const prev = prevStatus.current.get(d.id);
        if (prev && prev !== d.status && (d.status === "completed" || d.status === "failed")) notify(d);
        prevStatus.current.set(d.id, d.status);
      }
      setItems(r.items);
      if (r.stats) setStats(r.stats);
    } catch {
      /* server not ready */
    }
  }, []);

  const refreshSystem = useCallback(async () => {
    try {
      setSystem(await api<SystemInfo>("/api/system"));
    } catch {
      /* ignore */
    }
  }, []);

  // One stable timer. The previous version rebuilt `setInterval` on every
  // refresh (because `items` was a dependency) and captured a stale closure.
  useEffect(() => {
    const boot = setTimeout(() => {
      void refresh();
      void refreshSystem();
    }, 0);
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, 1200);
    return () => {
      clearTimeout(boot);
      clearInterval(timer);
    };
  }, [refresh, refreshSystem]);

  const active = items.filter((d) => ["downloading", "converting"].includes(d.status)).length;
  const queued = items.filter((d) => d.status === "queued").length;
  const done = items.filter((d) => d.status === "completed").length;
  const ytdlpOk = Boolean(system?.ytdlp.ok);
  const enginesOk = Boolean(system?.ytdlp.ok && system?.mediaToolsOk);

  return (
    <main className="mx-auto max-w-6xl px-4 pb-16 pt-6 md:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="bh-blackhole" />
          <div>
            <h1 className="text-xl font-extrabold tracking-tight md:text-2xl">
              BlackHole <span className="bg-gradient-to-l from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">Ultra Downloader</span>
            </h1>
            <p className="text-xs text-[var(--muted)]">yt-dlp + FFmpeg · مدير تحميل محلي · بدون إعلانات أو تتبع</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Stat label="نشط" value={active} glow={active > 0} />
          <Stat label="طابور" value={queued} />
          <Stat label="مكتمل" value={done} />
          {stats && (
            <div className="rounded-xl border border-[var(--border)] bg-black/30 px-3 py-1.5 text-center">
              <div className="text-base font-bold leading-tight text-violet-200">{fmtBytes(stats.bytes)}</div>
              <div className="text-[10px] text-[var(--muted)]">
                المكتبة · حر {stats.freeSpace ? fmtBytes(stats.freeSpace) : "—"}
              </div>
            </div>
          )}
          <PwaInstall />
          <NotifyButton />
          <button className="bh-icon-btn" title="الإعدادات" onClick={() => setShowSettings(true)}>⚙️</button>
        </div>
      </header>

      {system && !ytdlpOk && (
        <div className="mb-4 rounded-xl border border-amber-900 bg-amber-950/40 p-4 text-sm text-amber-100 fade-in">
          <p className="font-semibold">⚠️ لم يتم العثور على yt-dlp على هذا الجهاز.</p>
          <ul className="mt-2 list-disc space-y-1 pr-5 text-xs text-amber-200/90" dir="rtl">
            <li>Windows: <code dir="ltr">winget install yt-dlp.yt-dlp Gyan.FFmpeg</code> ثم أعد التشغيل، أو ضع <code>yt-dlp.exe</code> و<code>ffmpeg.exe</code> و<code>ffprobe.exe</code> في <code>bin/</code>.</li>
            <li>Linux/macOS: <code dir="ltr">pip install -U yt-dlp</code> و <code dir="ltr">apt install ffmpeg</code> / <code dir="ltr">brew install ffmpeg</code>.</li>
            <li>أو حدّد المسارات يدوياً من ⚙️ الإعدادات.</li>
          </ul>
        </div>
      )}
      {system && ytdlpOk && !system.mediaToolsOk && (
        <div className="mb-4 rounded-xl border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-100">
          ⚠️ أدوات الوسائط غير مكتملة: يلزم وجود FFmpeg وFFprobe معاً للدمج والتحويل إلى MP4/MKV/WEBM والصيغ الصوتية.
        </div>
      )}

      <div className="space-y-5">
        <AddDownload onAdded={refresh} defaultOutputDir={system?.outputDir ?? ""} enginesOk={enginesOk || !system} />
        <DownloadQueue items={items} onChanged={refresh} onPlay={setPlaying} />
      </div>

      <footer className="mt-10 text-center text-xs text-[var(--muted)]">
        استخدم التطبيق للمحتوى الذي تملك حق تحميله فقط. لا يتجاوز التطبيق أي حماية تقنية.
      </footer>

      {playing && <MediaPlayer item={playing} onClose={() => setPlaying(null)} />}
      {showSettings && (
        <SettingsPanel
          system={system}
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            void refreshSystem();
            void refresh();
          }}
        />
      )}
    </main>
  );
}

function Stat({ label, value, glow }: { label: string; value: number; glow?: boolean }) {
  return (
    <div className={`rounded-xl border border-[var(--border)] bg-black/30 px-3 py-1.5 text-center ${glow ? "shadow-[0_0_18px_-4px_#a855f7]" : ""}`}>
      <div className="text-base font-bold leading-tight text-violet-200">{value}</div>
      <div className="text-[10px] text-[var(--muted)]">{label}</div>
    </div>
  );
}

function notify(d: DownloadItem) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(d.status === "completed" ? "اكتمل التحميل ✓" : "فشل التحميل ✗", {
      body: d.title,
      icon: d.thumbnail ?? undefined,
      silent: false,
    });
  } catch {
    /* ignore */
  }
}
