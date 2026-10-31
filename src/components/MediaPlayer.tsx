"use client";

import { useEffect, useRef, useState } from "react";
import { fmtBytes, fmtDuration, type DownloadItem } from "./types";

export default function MediaPlayer({ item, onClose }: { item: DownloadItem; onClose: () => void }) {
  const src = `/api/downloads/${item.id}/file`;
  const isAudio = item.kind === "audio" || ["mp3", "m4a", "opus", "wav", "aac", "flac", "wma"].includes(item.container);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [meta, setMeta] = useState<{ duration?: number; width?: number; height?: number }>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onLoaded() {
    const m = mediaRef.current;
    if (!m) return;
    setMeta({
      duration: m.duration,
      width: (m as HTMLVideoElement).videoWidth || undefined,
      height: (m as HTMLVideoElement).videoHeight || undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bh-card w-full max-w-4xl overflow-hidden fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h3 className="truncate font-semibold" dir="auto">{item.title}</h3>
          <button className="bh-icon-btn" onClick={onClose} title="إغلاق (Esc)">✕</button>
        </div>

        <div className="bg-black">
          {isAudio ? (
            <div className="flex flex-col items-center gap-4 p-6">
              {item.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.thumbnail} alt="" className="h-56 w-56 rounded-2xl object-cover shadow-[0_0_60px_-10px_#a855f7]" />
              ) : (
                <div className="bh-blackhole !h-32 !w-32" />
              )}
              <audio ref={mediaRef} src={src} controls autoPlay className="w-full" onLoadedMetadata={onLoaded} onError={() => setError("تعذّر تشغيل الملف في المتصفح. جرّب صيغة MP3/M4A أو حمّله على الجهاز.")} />
            </div>
          ) : (
            <video ref={mediaRef} src={src} controls autoPlay playsInline className="max-h-[60vh] w-full" poster={item.thumbnail ?? undefined} onLoadedMetadata={onLoaded} onError={() => setError("تعذّر تشغيل هذه الصيغة في المتصفح (مثل MKV). استخدم MP4/WEBM أو حمّل الملف على الجهاز.")} />
          )}
        </div>

        {error && <div className="m-4 rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</div>}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-4 text-sm md:grid-cols-4">
          <Meta k="الناشر" v={item.uploader ?? "—"} />
          <Meta k="المدة" v={fmtDuration(meta.duration ?? item.duration)} />
          <Meta k="الصيغة" v={item.container.toUpperCase()} />
          <Meta k="الحجم" v={fmtBytes(item.totalBytes ?? item.downloadedBytes)} />
          {meta.width && <Meta k="الأبعاد" v={`${meta.width}×${meta.height}`} />}
          <Meta k="الجودة المطلوبة" v={item.qualityLabel} />
          <Meta k="اسم الملف" v={item.fileName ?? "—"} wide />
          <Meta k="المسار" v={item.filePath ?? "—"} wide />
        </dl>
      </div>
    </div>
  );
}

function Meta({ k, v, wide }: { k: string; v: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 md:col-span-4" : ""}>
      <dt className="text-xs text-[var(--muted)]">{k}</dt>
      <dd className="truncate font-medium" dir="auto" title={v}>{v}</dd>
    </div>
  );
}
