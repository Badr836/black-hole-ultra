"use client";

import { useState } from "react";
import { api, fmtBytes, fmtDuration, STATUS_COLOR, STATUS_LABEL, type DownloadItem } from "./types";

type Filter = "all" | "active" | "completed" | "failed";

export default function DownloadQueue({
  items,
  onChanged,
  onPlay,
}: {
  items: DownloadItem[];
  onChanged: () => void;
  onPlay: (d: DownloadItem) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLocaleLowerCase("ar");
  const filtered = items.filter((d) => {
    const statusMatch =
      filter === "all"
        ? true
        : filter === "active"
          ? ["queued", "downloading", "converting", "paused"].includes(d.status)
          : filter === "completed"
            ? d.status === "completed"
            : ["failed", "cancelled", "missing"].includes(d.status);
    if (!statusMatch) return false;
    if (!normalizedQuery) return true;
    return [d.title, d.uploader, d.fileName, d.url, d.container]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase("ar").includes(normalizedQuery));
  });

  const counts = {
    all: items.length,
    active: items.filter((d) => ["queued", "downloading", "converting", "paused"].includes(d.status)).length,
    completed: items.filter((d) => d.status === "completed").length,
    failed: items.filter((d) => ["failed", "cancelled", "missing"].includes(d.status)).length,
  };

  async function bulk(action: "pauseAll" | "resumeAll" | "clearFinished", deleteFiles = false) {
    if (action === "clearFinished" && deleteFiles) {
      const ok = confirm("سيتم حذف سجلات المكتمل/الملغى **وملفاتها من القرص**. هل أنت متأكد؟");
      if (!ok) return;
    }
    await api("/api/downloads", { method: "PATCH", body: JSON.stringify({ action, deleteFiles }) });
    onChanged();
  }

  return (
    <section className="bh-card p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(["all", "active", "completed", "failed"] as Filter[]).map((f) => (
            <button key={f} className={`bh-chip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
              {{ all: "الكل", active: "نشط", completed: "مكتمل", failed: "فشل/ملغى" }[f]}{" "}
              <span className="opacity-70">({counts[f]})</span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          <button className="bh-btn bh-btn-ghost text-xs" onClick={() => bulk("pauseAll")}>⏸ إيقاف الكل</button>
          <button className="bh-btn bh-btn-ghost text-xs" onClick={() => bulk("resumeAll")}>▶ استئناف الكل</button>
          <button className="bh-btn bh-btn-ghost text-xs" onClick={() => bulk("clearFinished")}>🧹 مسح المكتمل</button>
          <button className="bh-btn bh-btn-ghost text-xs" onClick={() => bulk("clearFinished", true)} title="حذف السجلات والملفات من القرص">🗑 مسح + حذف الملفات</button>
        </div>
      </div>

      <div className="relative mt-3 max-w-md">
        <input
          className="bh-input !py-2 !pr-9 text-sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ابحث بالعنوان، الناشر، الرابط أو الصيغة…"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)]">⌕</span>
      </div>

      {filtered.length === 0 ? (
        <div className="mt-8 flex flex-col items-center justify-center py-12 text-center text-[var(--muted)]">
          <div className="bh-blackhole mb-4" />
          <p>لا توجد تحميلات هنا بعد. الصق رابطاً في الأعلى وابدأ.</p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {filtered.map((d) => (
            <DownloadRow key={d.id} d={d} onChanged={onChanged} onPlay={onPlay} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DownloadRow({ d, onChanged, onPlay }: { d: DownloadItem; onChanged: () => void; onPlay: (d: DownloadItem) => void }) {
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const active = d.status === "downloading" || d.status === "converting";

  async function act(action: "pause" | "resume" | "retry" | "cancel" | "retry-missing") {
    setBusy(true);
    try {
      await api(`/api/downloads/${d.id}`, { method: "POST", body: JSON.stringify({ action }) });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  const missing = Array.isArray((d.metadata as { missingItems?: unknown } | null)?.missingItems)
    ? ((d.metadata as { missingItems: unknown[] }).missingItems)
    : [];

  async function remove() {
    const hasFile = d.status === "completed" && d.fileAvailable;
    let deleteFile = false;
    if (hasFile) {
      deleteFile = confirm(
        "حذف هذا العنصر. هل تريد حذف الملف من القرص أيضاً؟\n\nموافق = حذف الملف والسجل.\nإلغاء = حذف السجل فقط (يبقى الملف).",
      );
    } else if (!confirm("حذف هذا العنصر من القائمة؟")) {
      return;
    }
    setBusy(true);
    try {
      await api(`/api/downloads/${d.id}${deleteFile ? "?deleteFile=1" : ""}`, { method: "DELETE" });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <li className="rounded-xl border border-[var(--border)] bg-black/30 p-3 fade-in">
      <div className="flex gap-3">
        <div className="relative h-16 w-28 flex-none overflow-hidden rounded-lg bg-violet-950/40">
          {d.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={d.thumbnail} alt="" className="h-full w-full object-cover" />
          )}
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
            {d.container}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h4 className="truncate font-semibold" dir="auto" title={d.title}>
              {d.title}
            </h4>
            <span className={`flex-none rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_COLOR[d.status]}`}>
              {STATUS_LABEL[d.status]}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-[var(--muted)]" dir="auto">
            {d.kind === "audio" ? "🎵 صوت" : d.kind === "image" ? "🖼 صورة" : "🎬 فيديو"} · {d.qualityLabel} · {d.uploader ?? "—"} · {fmtDuration(d.duration)}
            {d.provider === "gallerydl" ? " · gallery-dl" : d.provider === "nm3u8dl" ? " · N_m3u8DL-RE" : ""}
            {d.playlist ? " · قائمة تشغيل" : ""}
            {d.completedEntries && d.completedEntries > 1 ? ` · ${d.completedEntries} ملف` : ""}
            {d.subtitles ? " · ترجمة" : ""}
          </p>

          <div className={`bh-progress mt-2 ${active ? "animated" : ""}`}>
            <div style={{ width: `${Math.max(d.status === "completed" ? 100 : d.progress, active ? 2 : 0)}%` }} />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]" dir="ltr">
            <span className="font-mono text-violet-300">{(d.status === "completed" ? 100 : d.progress).toFixed(1)}%</span>
            <span>{fmtBytes(d.downloadedBytes)} / {fmtBytes(d.totalBytes)}</span>
            {d.speed && <span className="text-fuchsia-300">⚡ {d.speed}</span>}
            {d.eta && <span>⏱ {d.eta}</span>}
            {d.retries > 0 && <span>↻ {d.retries}</span>}
            {d.fileName && (
              <span className="truncate max-w-[40ch]" title={d.filePath ?? ""}>
                📄 {d.fileName}
              </span>
            )}
          </div>
          {d.error && (
            <div className="mt-1">
              <p className="line-clamp-2 text-xs text-rose-300" dir="auto" title={d.error}>{d.error}</p>
              {d.log && (
                <button className="mt-1 text-[11px] text-violet-300 hover:text-violet-200" onClick={() => setShowLog((v) => !v)}>
                  {showLog ? "إخفاء سجل التشخيص ▲" : "عرض سجل التشخيص ▼"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {showLog && d.log && (
        <div className="mt-3 rounded-lg border border-[var(--border)] bg-black/60 p-3 fade-in">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[var(--muted)]">سجل yt-dlp / FFmpeg (آخر 12KB)</span>
            <button
              className="bh-btn bh-btn-ghost !px-2 !py-1 text-[11px]"
              onClick={async () => {
                await navigator.clipboard.writeText(d.log ?? "");
              }}
            >
              📋 نسخ
            </button>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-left text-[11px] leading-relaxed text-slate-300" dir="ltr">{d.log}</pre>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        {d.status === "completed" && d.files && d.files.length > 1 && (
          <span className="mr-auto text-[11px] text-[var(--muted)]">📚 {d.files.length} ملفات في المجلد</span>
        )}
        {(d.status === "downloading" || d.status === "queued" || d.status === "converting") && (
          <button className="bh-icon-btn" title="إيقاف مؤقت" disabled={busy} onClick={() => act("pause")}>⏸</button>
        )}
        {d.status === "paused" && (
          <button className="bh-icon-btn" title="استئناف" disabled={busy} onClick={() => act("resume")}>▶</button>
        )}
        {(d.status === "failed" || d.status === "cancelled" || d.status === "missing") && (
          <button className="bh-icon-btn" title="إعادة المحاولة" disabled={busy} onClick={() => act("retry")}>↻</button>
        )}
        {d.status === "completed" && missing.length > 0 && (
          <button
            className="bh-btn bh-btn-ghost !py-1.5 text-xs text-amber-200"
            title="تحميل العناصر الناقصة فقط، دون إعادة تحميل ما اكتمل"
            disabled={busy}
            onClick={() => act("retry-missing")}
          >
            ↻ إعادة الناقص ({missing.length})
          </button>
        )}
        {["downloading", "queued", "converting", "paused"].includes(d.status) && (
          <button className="bh-icon-btn" title="إلغاء" disabled={busy} onClick={() => act("cancel")}>✕</button>
        )}
        {d.status === "completed" && d.fileAvailable && (
          <>
            <button className="bh-btn bh-btn-primary !py-1.5 text-xs" onClick={() => onPlay(d)}>▶ تشغيل</button>
            <a className="bh-btn bh-btn-ghost !py-1.5 text-xs" href={`/api/downloads/${d.id}/file?download=1`}>⬇ حفظ على الجهاز</a>
          </>
        )}
        <a className="bh-icon-btn" title="فتح الرابط الأصلي" href={d.url} target="_blank" rel="noreferrer">🔗</a>
        <button className="bh-icon-btn text-rose-300" title="حذف من القائمة" disabled={busy} onClick={remove}>🗑</button>
      </div>
    </li>
  );
}
