"use client";

import { useState } from "react";
import { api, fmtBytes, fmtDuration, type AnalyzeResult, type HlsInspect } from "./types";

const QUALITIES = [
  { value: "best", label: "تلقائي", sub: "أفضل جودة" },
  { value: "4320", label: "8K", sub: "4320p" },
  { value: "2160", label: "4K", sub: "2160p" },
  { value: "1440", label: "2K", sub: "1440p" },
  { value: "1080", label: "FHD", sub: "1080p" },
  { value: "720", label: "HD", sub: "720p" },
  { value: "480", label: "SD", sub: "480p" },
  { value: "360", label: "360p", sub: "منخفض" },
  { value: "240", label: "240p", sub: "موفّر" },
  { value: "144", label: "144p", sub: "الأقل" },
];
const VIDEO_CONTAINERS = ["mp4", "mkv", "webm"];
const AUDIO_CONTAINERS = ["mp3", "m4a", "opus", "wav", "aac", "flac", "wma"];

type Props = { onAdded: () => void; defaultOutputDir: string; enginesOk: boolean };

export default function AddDownload({ onAdded, defaultOutputDir, enginesOk }: Props) {
  const [url, setUrl] = useState("");
  const [playlist, setPlaylist] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<AnalyzeResult | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [kind, setKind] = useState<"video" | "audio">("video");
  const [quality, setQuality] = useState("best");
  const [container, setContainer] = useState("mp4");
  const [audioFormatId, setAudioFormatId] = useState("");
  const [subs, setSubs] = useState(false);
  const [outputDir, setOutputDir] = useState("");
  const [playlistItems, setPlaylistItems] = useState("");
  // HLS (m3u8) extras: session page + real stream inspection.
  const [hlsInfo, setHlsInfo] = useState<HlsInspect | null>(null);
  const [hlsError, setHlsError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [pageUrl, setPageUrl] = useState("");
  const [hlsAudioLang, setHlsAudioLang] = useState("");
  const [hlsRange, setHlsRange] = useState("");
  const [hlsCodecs, setHlsCodecs] = useState("");
  const looksHls = /\.m3u8?(\?|$)/i.test(url.trim());

  const busy = analyzing || adding;

  async function inspectHls() {
    setHlsError(null);
    setInspecting(true);
    try {
      const result = await api<HlsInspect>("/api/hls/inspect", {
        method: "POST",
        body: JSON.stringify({ url: url.trim(), pageUrl: pageUrl.trim() || null }),
      });
      setHlsInfo(result);
      const heights = result.suggestions?.heights ?? [];
      if (!heights.includes(Number(quality))) setQuality(heights.length ? String(heights[0]) : "best");
      const languages = result.suggestions?.audioLanguages ?? [];
      if (languages.length && !languages.includes(hlsAudioLang)) setHlsAudioLang(languages[0] as string);
    } catch (e) {
      setHlsError(e instanceof Error ? e.message : "تعذّر فحص البث");
    } finally {
      setInspecting(false);
    }
  }
  const maxHeight = Math.max(0, ...(info?.videoOptions.map((v) => v.height) ?? [0]));
  const selectedQuality = QUALITIES.find((q) => q.value === quality)?.sub ?? (quality.startsWith("id:") ? "صيغة خام" : quality);

  async function pasteLink() {
    setError(null);
    try {
      if (!navigator.clipboard?.readText) throw new Error("المتصفح لا يسمح بقراءة الحافظة");
      const text = await navigator.clipboard.readText();
      const link = text.match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[),.;]+$/, "") ?? text.trim();
      if (!/^https?:\/\//i.test(link)) throw new Error("لا يوجد رابط صالح في الحافظة");
      setUrl(link);
      setInfo(null);
    } catch (e) {
      setError(`${e instanceof Error ? e.message : "تعذّرت قراءة الحافظة"}. اسمح للموقع بالوصول إلى الحافظة من إعدادات المتصفح.`);
    }
  }

  async function analyzeLink(): Promise<AnalyzeResult> {
    const r = await api<AnalyzeResult>("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ url, playlist }),
    });
    setInfo(r);
    return r;
  }

  async function analyze() {
    setError(null);
    setInfo(null);
    setAnalyzing(true);
    try {
      await analyzeLink();
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل التحليل");
    } finally {
      setAnalyzing(false);
    }
  }

  async function enqueue(selected: AnalyzeResult) {
    // gallery-dl posts may be photo sets, not video: honour what was detected.
    const mediaKind = selected.mediaKind ?? "video";
    const sendKind = mediaKind === "image" ? "image" : kind;
    const sendContainer = mediaKind === "image" ? selected.directOptions?.[0]?.ext ?? "jpg" : container;
    const sendQuality = mediaKind === "image" ? "id:gallery" : quality;
    // Progressive/direct formats already carry audio; asking yt-dlp to merge
    // would force FFmpeg for no reason (and broke plain media URLs before).
    const rawChoice = quality.startsWith("id:")
      ? selected.videoOptions.find((option) => `id:${option.formatId}` === quality)
      : undefined;

    await api("/api/downloads", {
      method: "POST",
      body: JSON.stringify({
        url: selected.webpageUrl || url,
        title: selected.title,
        thumbnail: selected.thumbnail,
        uploader: selected.uploader,
        duration: selected.duration,
        kind: sendKind,
        quality: sendQuality,
        container: sendContainer,
        audioFormatId: audioFormatId || null,
        mergeAudio: rawChoice ? !rawChoice.single : true,
        subtitles: subs,
        playlist: selected.isPlaylist || playlist,
        playlistItems: playlistItems.trim() || null,
        outputDir: outputDir || undefined,
        metadata: { extractor: selected.extractor, entryCount: selected.entryCount, id: selected.id },
        pageUrl: pageUrl.trim() || null,
        hlsAudioLang: hlsAudioLang || null,
        hlsRange: hlsRange || null,
        hlsCodecs: hlsCodecs || null,
      }),
    });
    setInfo(null);
    setUrl("");
    onAdded();
  }

  async function quickAdd() {
    setError(null);
    setAdding(true);
    try {
      const resolved = info ?? (await analyzeLink());
      await enqueue(resolved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل التحميل");
    } finally {
      setAdding(false);
    }
  }

  function switchKind(next: "video" | "audio") {
    setKind(next);
    setContainer(next === "video" ? "mp4" : "mp3");
    setQuality("best");
  }

  return (
    <section className="bh-card p-4 md:p-6 fade-in">
      <div className="flex flex-col gap-2 md:flex-row">
        <div className="relative min-w-0 flex-1">
          <input
            className="bh-input !pl-24 text-base"
            dir="ltr"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="ألصق رابط فيديو أو صوت من أي منصة مدعومة…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setInfo(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && url && analyze()}
          />
          <button
            type="button"
            onClick={pasteLink}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-lg border border-violet-800/70 bg-violet-950/70 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-900"
            title="لصق الرابط من الحافظة"
          >
            📋 لصق
          </button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            className="bh-btn bh-btn-primary w-full sm:w-auto sm:flex-none"
            disabled={!url || busy || !enginesOk}
            onClick={analyze}
          >
            {analyzing ? <><Spinner /> تحليل…</> : <>🔍 تحليل الرابط</>}
          </button>
          <button
            className="bh-btn bh-btn-ghost w-full sm:w-auto sm:flex-none"
            disabled={!url || busy || !enginesOk}
            onClick={quickAdd}
          >
            {adding ? <Spinner /> : "⚡"} تحميل
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={`bh-chip ${showOptions ? "active" : ""}`} onClick={() => setShowOptions((v) => !v)}>
          ⚙ خيارات التحميل
        </button>
        <span className="rounded-full border border-[var(--border)] bg-black/30 px-3 py-1 text-xs text-[var(--muted)]">
          {kind === "video" ? "🎬 فيديو" : "🎵 صوت"} · {kind === "video" ? selectedQuality : "أفضل صوت"} · {container.toUpperCase()}
        </span>
        {subs && <span className="text-xs text-violet-300">CC ترجمة</span>}
        {playlist && <span className="text-xs text-violet-300">☷ قائمة تشغيل</span>}
      </div>

      {showOptions && (
        <div className="mt-3 rounded-xl border border-[var(--border)] bg-black/25 p-4 fade-in">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <Label>نوع التحميل</Label>
              <div className="flex flex-wrap gap-2">
                <button className={`bh-chip ${kind === "video" ? "active" : ""}`} onClick={() => switchKind("video")}>🎬 فيديو + صوت</button>
                <button className={`bh-chip ${kind === "audio" ? "active" : ""}`} onClick={() => switchKind("audio")}>🎵 صوت فقط</button>
              </div>
            </div>
            <div>
              <Label>الصيغة النهائية</Label>
              <div className="flex flex-wrap gap-2">
                {(kind === "video" ? VIDEO_CONTAINERS : AUDIO_CONTAINERS).map((c) => (
                  <button key={c} className={`bh-chip uppercase ${container === c ? "active" : ""}`} onClick={() => setContainer(c)}>{c}</button>
                ))}
              </div>
              {container === "wma" && <p className="mt-1 text-[11px] text-[var(--muted)]">يُحوّل محلياً إلى WMA 192kbps عبر FFmpeg.</p>}
            </div>
          </div>

          {kind === "video" && (
            <div className="mt-4">
              <Label>الجودة</Label>
              <div className="flex flex-wrap gap-2">
                {QUALITIES.map((q) => {
                  const height = Number(q.value);
                  const hasSuitableStream = info?.videoOptions.some((v) => v.height <= height) ?? true;
                  const unavailable = q.value !== "best" && Boolean(info?.videoOptions.length) && (height > maxHeight || !hasSuitableStream);
                  return (
                    <button
                      key={q.value}
                      className={`bh-chip ${quality === q.value ? "active" : ""} ${unavailable ? "opacity-35" : ""}`}
                      disabled={unavailable}
                      title={unavailable ? "غير متاحة في هذا الفيديو" : q.sub}
                      onClick={() => setQuality(q.value)}
                    >
                      <b>{q.label}</b> <span className="text-[10px] opacity-70">{q.sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-[var(--muted)]">
            <Check checked={playlist} onChange={setPlaylist}>قائمة التشغيل كاملة</Check>
            <Check checked={subs} onChange={setSubs}>الترجمة العربية/الإنجليزية</Check>
          </div>

          {(playlist || info?.isPlaylist) && (
            <div className="mt-3">
              <Label>عناصر قائمة التشغيل (اختياري — الموضع الأصلي)</Label>
              <input
                className="bh-input"
                dir="ltr"
                placeholder="مثال: 1-5,8,12-14 — اتركه فارغاً للكل"
                value={playlistItems}
                onChange={(event) => setPlaylistItems(event.target.value)}
              />
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                {info?.isPlaylist && info.entryCount ? `القائمة تحتوي ${info.entryCount} عنصر. ` : ""}
                يُمرَّر إلى yt-dlp كـ --playlist-items.
              </p>
            </div>
          )}

          {info && (
            <>
              <button className="mt-3 text-xs text-violet-300 hover:text-violet-200" onClick={() => setAdvanced((v) => !v)}>
                {advanced ? "▲ إخفاء الاختيارات الخام" : "▼ اختيار format ID أو مجلد مخصّص"}
              </button>
              {advanced && (
                <div className="mt-3 grid gap-3 md:grid-cols-2 fade-in">
                  {kind === "video" && (
                    <div>
                      <Label>مسار الفيديو الخام</Label>
                      <select className="bh-input" dir="ltr" value={quality.startsWith("id:") ? quality : ""} onChange={(e) => setQuality(e.target.value || "best")}>
                        <option value="">تلقائي حسب الجودة</option>
                        {info.videoOptions.map((v) => <option key={v.formatId} value={`id:${v.formatId}`}>{v.label} · {v.ext} · {v.vcodec} · {fmtBytes(v.filesize)} [{v.formatId}]</option>)}
                      </select>
                    </div>
                  )}
                  <div>
                    <Label>مسار الصوت الخام</Label>
                    <select
                      className="bh-input"
                      dir="ltr"
                      value={kind === "audio" ? (quality.startsWith("id:") ? quality.slice(3) : "") : audioFormatId}
                      onChange={(e) => kind === "audio" ? setQuality(e.target.value ? `id:${e.target.value}` : "best") : setAudioFormatId(e.target.value)}
                    >
                      <option value="">أفضل صوت تلقائياً</option>
                      {info.audioOptions.map((a) => <option key={a.formatId} value={a.formatId}>{a.label} · {a.ext} · {fmtBytes(a.filesize)} [{a.formatId}]</option>)}
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <Label>مجلد الحفظ</Label>
                    <input className="bh-input" dir="ltr" placeholder={defaultOutputDir} value={outputDir} onChange={(e) => setOutputDir(e.target.value)} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {looksHls && (
        <div className="mt-3 rounded-xl border border-[var(--border)] bg-black/25 p-4 fade-in">
          <div className="flex flex-wrap items-center justifies-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">بث HLS مباشر (m3u8)</p>
              <p className="text-[11px] text-[var(--muted)]">
                افحص المانيفست لتعرف الجودات ولغات الصوت المتاحة فعلاً، أو أضف رابط صفحة المشاهدة ليُستنتج Referer تلقائياً.
              </p>
            </div>
            <button className="bh-btn bh-btn-ghost text-xs" disabled={inspecting || !url} onClick={inspectHls}>
              {inspecting ? <Spinner /> : "🔎"} فحص البث
            </button>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label>رابط صفحة المشاهدة (اختياري — يُشتق منه Referer/Origin)</Label>
              <input
                className="bh-input"
                dir="ltr"
                placeholder="https://example.com/watch/123"
                value={pageUrl}
                onChange={(e) => setPageUrl(e.target.value)}
              />
            </div>
            <div>
              <Label>لغة الصوت</Label>
              <select className="bh-input" dir="ltr" value={hlsAudioLang} onChange={(e) => setHlsAudioLang(e.target.value)}>
                <option value="">تلقائي (أفضل مسار)</option>
                {(hlsInfo?.suggestions?.audioLanguages ?? []).map((lang) => (
                  <option key={lang as string} value={lang as string}>
                    {String(lang)}
                  </option>
                ))}
                {["ar", "en", "fr", "es", "tr"].map((lang) => (
                  <option key={`manual-${lang}`} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>مدى الفيديو</Label>
              <select className="bh-input" dir="ltr" value={hlsRange} onChange={(e) => setHlsRange(e.target.value)}>
                <option value="">تلقائي</option>
                <option value="SDR">SDR</option>
                <option value="HDR">HDR</option>
              </select>
            </div>
            <div>
              <Label>الترميز (codecs)</Label>
              <select className="bh-input" dir="ltr" value={hlsCodecs} onChange={(e) => setHlsCodecs(e.target.value)}>
                <option value="">تلقائي</option>
                {["avc1", "hvc1", "hev1", "av01", "vp09"].map((codec) => (
                  <option key={codec} value={codec}>
                    {codec}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end text-[11px] text-[var(--muted)]">
              {hlsInfo?.headersUsed ? `الترويسات المقبولة: ${hlsInfo.headersUsed}` : "الترويسات تُفحص عند بدء التحميل (user → page → نفس النطاق)"}
            </div>
          </div>

          {hlsInfo && (hlsInfo.variants?.length ?? 0) > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[var(--muted)]">
                  <tr>
                    <th className="py-1 text-right">الارتفاع</th>
                    <th className="py-1 text-right">المدى</th>
                    <th className="py-1 text-right">الترميز</th>
                    <th className="py-1 text-right">المعدل</th>
                  </tr>
                </thead>
                <tbody dir="ltr" className="text-center">
                  {(hlsInfo.variants ?? []).slice(0, 8).map((variant, index) => (
                    <tr key={`${variant.url}-${index}`} className="border-t border-[var(--border)]">
                      <td className="py-1">{variant.height ? `${variant.height}p` : "صوت"}</td>
                      <td className="py-1">{variant.range ?? "SDR"}</td>
                      <td className="py-1">{variant.codecs ?? "—"}</td>
                      <td className="py-1">{variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(hlsInfo.audio?.length ?? 0) > 0 && (
                <p className="mt-2 text-[11px] text-[var(--muted)]" dir="auto">
                  مسارات صوت: {(hlsInfo.audio ?? []).map((a) => `${a.name ?? a.language ?? "?"}${a.language ? ` (${a.language})` : ""}`).join("، ")}
                </p>
              )}
            </div>
          )}

          {hlsError && (
            <div className="mt-3 rounded-lg border border-amber-900/70 bg-amber-950/25 p-2 text-xs text-amber-100" dir="auto">
              {hlsError}
            </div>
          )}
        </div>
      )}

      {info?.hint && (
        <div className="mt-3 rounded-xl border border-amber-900/70 bg-amber-950/25 p-3 text-xs text-amber-100" dir="auto">
          💡 {info.hint}
        </div>
      )}

      {error && <div className="mt-3 rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200" dir="auto">{error}</div>}

      {info && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-black/30 p-3 fade-in sm:flex-row sm:items-center">
          {info.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={info.thumbnail} alt="" className="h-24 w-full rounded-lg object-cover sm:w-40" />
          ) : <div className="h-20 w-full rounded-lg bg-violet-950/40 sm:w-36" />}
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 font-semibold" dir="auto">{info.title}</h3>
            <p className="mt-1 text-xs text-[var(--muted)]" dir="auto">
              {info.uploader ?? info.extractor} · {fmtDuration(info.duration)}
              {info.isPlaylist && info.entryCount ? ` · ${info.entryCount} عنصر` : ""}
              {info.provider === "gallerydl" ? " · gallery-dl" : ""}
              {maxHeight ? ` · حتى ${maxHeight}p` : ""}
            </p>
          </div>
          <button className="bh-btn bh-btn-primary sm:self-end" disabled={adding} onClick={quickAdd}>
            {adding ? <Spinner /> : "⬇"} تنزيل {container.toUpperCase()}
          </button>
        </div>
      )}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-[11px] font-bold tracking-wide text-[var(--muted)]">{children}</div>;
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" className="accent-violet-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />{children}</label>;
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />;
}
