"use client";

import { useEffect, useState } from "react";
import { api, type AccessInfo, type Settings, type SystemInfo } from "./types";
import { Spinner } from "./AddDownload";

export default function SettingsPanel({ system, onClose, onSaved }: { system: SystemInfo | null; onClose: () => void; onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Per-key rejection reasons returned by PUT /api/settings (e.g. a bad tool path).
  const [reasons, setReasons] = useState<Record<string, string>>({});
  // Access-token management (round 5): source, value, rotation, LAN links.
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [rotating, setRotating] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [accessMsg, setAccessMsg] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<{
    ok: boolean;
    checks: {
      ytdlp: { ok: boolean; version: string | null };
      ffmpeg: { ok: boolean; version: string | null };
      ffprobe: { ok: boolean; version: string | null };
      mediaToolsMatch: boolean;
      extractorCount: number;
      impersonation: { supported: boolean; targets: string[] };
      outputWritable: boolean;
      freeSpace: { bytes: number | null; human: string };
      database: { engine: string; schemaVersion: number };
      nodeRuntime: { ok: boolean; version: string };
      aria2c?: { ok: boolean; version: string | null };
      features?: {
        jsRuntime: { state: string; message: string; hint: string | null };
        externalDownloader: { state: string; note: string };
        downloadArchive: { enabled: boolean };
        sponsorBlock: { mode: string };
        concurrentFragments: { value: number };
      };
      providerStats?: { provider: string; status: string; count: number }[];
      engineFreshness?: { checkedAt: string | null; note: string | null };
    };
    warnings: string[];
    elapsedMs: number;
  } | null>(null);

  useEffect(() => {
    api<Settings>("/api/settings").then(setS).catch(() => null);
    api<AccessInfo>("/api/access")
      .then(setAccess)
      .catch(() => null);
  }, []);

  async function rotateToken() {
    setRotating(true);
    setAccessMsg(null);
    try {
      const next = await api<AccessInfo>("/api/access", { method: "POST", body: JSON.stringify({ action: "rotate" }) });
      setAccess(next);
      setShowToken(true);
      setAccessMsg(next.note ?? "تم تدوير الرمز.");
    } catch (e) {
      setAccessMsg(e instanceof Error ? e.message : "تعذّر تدوير الرمز");
    } finally {
      setRotating(false);
    }
  }

  async function copyToken() {
    if (!access?.token) return;
    try {
      await navigator.clipboard.writeText(access.token);
      setAccessMsg("نُسخ الرمز إلى الحافظة.");
    } catch {
      setAccessMsg("المتصفح منع الوصول إلى الحافظة — حدّد الرمز وانسخه يدوياً.");
    }
  }

  async function save() {
    if (!s) return;
    setSaving(true);
    setMsg(null);
    try {
      const updated = await api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(s) });
      setS(updated);
      // The API reports which values it refused and why (Arabic, per key).
      const rejected = (updated as Settings & { rejected?: string[] }).rejected ?? [];
      setMsg(rejected.length ? `حُفظ الباقي، ورُفض: ${rejected.join("، ")}` : "تم الحفظ ✓");
      setReasons((updated as Settings & { reasons?: Record<string, string> }).reasons ?? {});
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "فشل الحفظ");
      setReasons({});
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-start bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside className="h-full w-full max-w-md overflow-y-auto border-l border-[var(--border)] bg-[var(--bg-2)] p-5 fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">الإعدادات</h2>
          <button className="bh-icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="mt-5 rounded-xl border border-[var(--border)] bg-black/30 p-3 text-sm">
          <h3 className="mb-2 font-semibold">حالة المحركات</h3>
          <EngineRow name="yt-dlp" info={system?.ytdlp} />
          <EngineRow name="gallery-dl" info={system?.gallerydl} />
          <EngineRow name="N_m3u8DL-RE" info={system?.nm3u8dl} />
          <EngineRow name="FFmpeg" info={system?.ffmpeg} />
          <EngineRow name="FFprobe" info={system?.ffprobe} />
          <p className="mt-2 text-xs text-[var(--muted)]">
            النظام: {system?.platform ?? "—"}. يتم البحث في PATH، ثم مجلد <code>bin/</code> داخل المشروع، ثم المسارات المحددة أدناه.
          </p>
          <button
            className="bh-btn bh-btn-ghost mt-3 w-full text-xs"
            disabled={diagnosing}
            onClick={async () => {
              setDiagnosing(true);
              try {
                setDiagnostics(await api<NonNullable<typeof diagnostics>>("/api/diagnostics"));
              } catch (e) {
                setMsg(e instanceof Error ? e.message : "فشل الفحص");
              } finally {
                setDiagnosing(false);
              }
            }}
          >
            {diagnosing ? "جارٍ فحص المحركات…" : "🩺 تشغيل الفحص الشامل"}
          </button>
          {diagnostics && (
            <div className={`mt-3 rounded-lg border p-3 text-xs ${diagnostics.ok ? "border-emerald-800 bg-emerald-950/30" : "border-rose-800 bg-rose-950/30"}`}>
              <p className="font-bold">{diagnostics.ok ? "✓ المحركات الأساسية جاهزة" : "✗ يوجد نقص في المحركات"}</p>
              <div className="mt-2 grid grid-cols-2 gap-1 text-[var(--muted)]">
                <span>yt-dlp: {diagnostics.checks.ytdlp.ok ? "✓" : "✗"}</span>
                <span>FFmpeg: {diagnostics.checks.ffmpeg.ok ? "✓" : "✗"}</span>
                <span>FFprobe: {diagnostics.checks.ffprobe.ok ? "✓" : "✗"}</span>
                <span>تطابق الأدوات: {diagnostics.checks.mediaToolsMatch ? "✓" : "✗"}</span>
                <span>المستخرجات: {diagnostics.checks.extractorCount}</span>
                <span>بصمات المتصفح: {diagnostics.checks.impersonation.supported ? diagnostics.checks.impersonation.targets.length : "غير متاح"}</span>
                <span>مجلد الحفظ: {diagnostics.checks.outputWritable ? "قابل للكتابة ✓" : "غير قابل للكتابة ✗"}</span>
                <span>Node: {diagnostics.checks.nodeRuntime.version}</span>
                <span>قاعدة البيانات: {diagnostics.checks.database.engine} v{diagnostics.checks.database.schemaVersion}</span>
                <span>المساحة الحرة: {diagnostics.checks.freeSpace.human}</span>
              </div>
              {diagnostics.checks.features && (
                <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
                  <p>محرك JS: {diagnostics.checks.features.jsRuntime.state === "active" ? "✓" : "✗"} {diagnostics.checks.features.jsRuntime.message}</p>
                  {diagnostics.checks.features.jsRuntime.hint && <p className="text-amber-200" dir="ltr">{diagnostics.checks.features.jsRuntime.hint}</p>}
                  <p>aria2c: {diagnostics.checks.features.externalDownloader.state === "active" ? `✓ ${diagnostics.checks.aria2c?.version ?? ""}` : diagnostics.checks.features.externalDownloader.state === "disabled" ? "معطّل (افتراضي)" : "مفعّل لكن غير مثبّت"}</p>
                  <p>الأرشيف: {diagnostics.checks.features.downloadArchive.enabled ? "مفعّل" : "معطّل"} · SponsorBlock: {diagnostics.checks.features.sponsorBlock.mode}</p>
                  <p>مقاطع متوازية: {diagnostics.checks.features.concurrentFragments.value}</p>
                  {diagnostics.checks.engineFreshness?.note && <p className="text-amber-200">{diagnostics.checks.engineFreshness.note}</p>}
                  {diagnostics.checks.providerStats && diagnostics.checks.providerStats.length > 0 && (
                    <p className="opacity-80">
                      إحصاء المزوّدات: {diagnostics.checks.providerStats.map((row) => `${row.provider}/${row.status}: ${row.count}`).join(" · ")}
                    </p>
                  )}
                </div>
              )}
              {diagnostics.warnings.map((warning) => <p key={warning} className="mt-1 text-amber-200">⚠ {warning}</p>)}
              <p className="mt-1 text-[10px] opacity-60">استغرق {diagnostics.elapsedMs}ms</p>
            </div>
          )}
        </div>

        {s && (
          <div className="mt-5 space-y-4 text-sm">
            <Field label="محرّك التحميل">
              <select
                className="bh-input"
                value={s.providerPreference ?? "auto"}
                onChange={(e) =>
                  setS({
                    ...s,
                    providerPreference: e.target.value as "auto" | "ytdlp" | "gallerydl" | "nm3u8dl",
                  })
                }
              >
                <option value="auto">تلقائي (حسب نوع الرابط) — موصى به</option>
                <option value="ytdlp">yt-dlp دائماً (فيديو)</option>
                <option value="gallerydl">gallery-dl دائماً (منشورات/صور/X/إنستغرام)</option>
                <option value="nm3u8dl">N_m3u8DL-RE دائماً (روابط m3u8 فقط)</option>
              </select>
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                التلقائي يوجّه إنستغرام/X/Pinterest/ريديت إلى gallery-dl، ويحوّل المهمة تلقائياً إذا فشل المحرك الأول في فهم الرابط.
                روابط m3u8 تنتقل تلقائياً إلى N_m3u8DL-RE عند فشل yt-dlp (بث محمي بترويسات/كوكيز).
              </p>
            </Field>

            <Field label="مجلد الحفظ الافتراضي">
              <input className="bh-input" dir="ltr" value={s.outputDir} onChange={(e) => setS({ ...s, outputDir: e.target.value })} />
            </Field>
            <Field label="قالب اسم الملف (yt-dlp output template)">
              <input className="bh-input" dir="ltr" value={s.fileNameTemplate} onChange={(e) => setS({ ...s, fileNameTemplate: e.target.value })} />
              <p className="mt-1 text-xs text-[var(--muted)]">مثال: %(title)s [%(id)s].%(ext)s — أو %(playlist_index)s - %(title)s.%(ext)s للقوائم</p>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="التحميلات المتزامنة">
                <input
                  type="number"
                  min={1}
                  max={16}
                  className="bh-input"
                  value={s.maxConcurrent}
                  onChange={(e) => setS({ ...s, maxConcurrent: Number(e.target.value) })}
                />
                <p className="mt-1 text-[11px] text-[var(--muted)]">
                  كم تحميلاً يعمل في الوقت نفسه (1–16). القيمة الافتراضية 3 — ارفعها فقط إذا كان اتصالك وجعالك يتحمّلان ذلك.
                </p>
              </Field>
              <Field label="عدد إعادة المحاولة">
                <input type="number" min={0} max={10} className="bh-input" value={s.maxRetries} onChange={(e) => setS({ ...s, maxRetries: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-black/25 p-3 space-y-3">
              <div>
                <p className="text-sm font-semibold">الأداء والتوافق مع يوتيوب</p>
                <p className="text-[11px] text-[var(--muted)]">كل خيار هنا يشرح حالته بنفسه، ولا يُغيّر أي إعداد افتراضي خاص بالخصوصية.</p>
              </div>
              <Field label="المنزّل الخارجي (aria2c) — للروابط المباشرة فقط">
                <select
                  className="bh-input"
                  value={s.externalDownloader ?? "off"}
                  onChange={(e) => setS({ ...s, externalDownloader: e.target.value as "off" | "aria2c" })}
                >
                  <option value="off">معطّل (افتراضي) — منزّل yt-dlp الداخلي</option>
                  <option value="aria2c">aria2c — أسرع للروابط المباشرة</option>
                </select>
                <p className="mt-1 text-[11px] text-[var(--muted)]">
                  يُمرّر كـ <code dir="ltr">http:aria2c</code> فقط، فلا يلمس مقاطع DASH/HLS. يحتاج تثبيت aria2c، وإلا ستظهر رسالة واضحة بدل تعطّل صامت.
                </p>
              </Field>
              <Field label="عدد المقاطع المتوازية لكل تحميل (1–16)">
                <input
                  type="number"
                  min={1}
                  max={16}
                  className="bh-input"
                  value={s.concurrentFragments ?? 4}
                  onChange={(e) => setS({ ...s, concurrentFragments: Number(e.target.value) })}
                />
              </Field>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-violet-500"
                  checked={s.downloadArchive ?? false}
                  onChange={(e) => setS({ ...s, downloadArchive: e.target.checked })}
                />
                <span className="text-xs leading-relaxed">
                  <b>تخطّي ما نُزّل سابقاً (أرشيف لكل مجلد)</b>
                  <span className="block text-[var(--muted)]">
                    يُنشئ ملف <code dir="ltr">.blackhole-archive.txt</code> داخل مجلد الحفظ. الملف الموجود مسبقاً يُسجّل «تم تخطيه» لا «فشل».
                  </span>
                </span>
              </label>
              <Field label="SponsorBlock (يوتيوب) — يرسل معرّف الفيديو لطرف ثالث">
                <select
                  className="bh-input"
                  value={s.sponsorBlock ?? "off"}
                  onChange={(e) => setS({ ...s, sponsorBlock: e.target.value as "off" | "mark" | "remove" })}
                >
                  <option value="off">معطّل (افتراضي)</option>
                  <option value="mark">وسم مقاطع الرعاية فقط</option>
                  <option value="remove">حذف مقاطع الرعاية</option>
                </select>
                <p className="mt-1 text-[11px] text-amber-200/80">
                  عند التفعيل يُرسل معرّف الفيديو إلى خدمة sponsor.ink (طرف ثالث). اتركه معطّلاً إن أردت «لا تتبّع» بالكامل.
                </p>
              </Field>
              <Field label="مسار محرك JavaScript (اختياري: deno/bun/node 22+)">
                <input
                  className="bh-input"
                  dir="ltr"
                  placeholder="يُكتشف تلقائياً"
                  value={s.jsRuntimePath ?? ""}
                  onChange={(e) => setS({ ...s, jsRuntimePath: e.target.value })}
                />
                <p className="mt-1 text-[11px] text-[var(--muted)]">
                  مطلوب ليوتيوب الحديث (حل تحديات JS). بدون محرك صالح قد تفشل بعض الجودات برسالة 403.
                </p>
              </Field>
            </div>
            <Field label="حد السرعة لكل تحميل (مثال: 2M أو 500K، فارغ = بلا حد)">
              <input className="bh-input" dir="ltr" placeholder="unlimited" value={s.speedLimit ?? ""} onChange={(e) => setS({ ...s, speedLimit: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-violet-500" checked={s.embedThumbnail} onChange={(e) => setS({ ...s, embedThumbnail: e.target.checked })} />
              تضمين الصورة المصغرة في الملف
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-violet-500" checked={s.embedMetadata} onChange={(e) => setS({ ...s, embedMetadata: e.target.checked })} />
              تضمين البيانات الوصفية (العنوان، الفنان، …)
            </label>
            <label className="flex items-start gap-2 cursor-pointer rounded-xl border border-rose-900/70 bg-rose-950/20 p-3">
              <input
                type="checkbox"
                className="mt-1 accent-rose-500"
                checked={s.allowInsecureTls}
                onChange={(e) => setS({ ...s, allowInsecureTls: e.target.checked })}
              />
              <span className="text-xs leading-relaxed">
                <b className="text-rose-200">تعطيل التحقق من شهادة TLS</b>
                <span className="block text-[var(--muted)]">
                  مُغلق افتراضياً. شغّله فقط إذا كنت خلف وسيط شركة يفتح الاتصالات (MITM). تعطيله يسمح
                  باعتراض التحميلات.
                </span>
              </span>
            </label>

            <div className="rounded-xl border border-[var(--border)] bg-black/25 p-3 space-y-2">
              <p className="text-sm font-semibold">جلسة الكوكيز (إنستغرام · ريديت · Vimeo · X)</p>
              <p className="text-[11px] text-[var(--muted)]">
                المواقع التي تشترط تسجيل دخول لا تُحمَّل بغير جلستك. صدّر cookies.txt بصيغة Netscape وارفعه هنا — يبقى على جهازك فقط.
              </p>
              <CookiesBox />
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-black/25 p-3 space-y-2">
              <p className="text-sm font-semibold">نسخ احتياطي للإعدادات</p>
              <p className="text-[11px] text-[var(--muted)]">ملف JSON قابل للمشاركة (لا يحتوي مسارات الأدوات التنفيذية).</p>
              <div className="flex flex-wrap gap-2">
                <a className="bh-btn bh-btn-ghost text-xs" href="/api/settings/backup">⬇ تصدير</a>
                <label className="bh-btn bh-btn-ghost cursor-pointer text-xs">
                  ⬆ استعادة
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      try {
                        const text = await file.text();
                        const result = await api<{ ok: boolean; changed: string[] }>("/api/settings/backup", {
                          method: "POST",
                          body: text,
                        });
                        setMsg(`تمت الاستعادة ✓ (${result.changed.length} حقول)`);
                        const fresh = await api<Settings>("/api/settings");
                        setS(fresh);
                        onSaved();
                      } catch (e) {
                        setMsg(e instanceof Error ? e.message : "فشل الاستعادة");
                      }
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-black/25 p-3 space-y-3">
              <div>
                <p className="text-sm font-semibold">توافق المواقع التي تتطلب تسجيل دخول</p>
                <p className="text-[11px] text-[var(--muted)]">اختياري. تستخدم الجلسة محلياً فقط ولا تُرسل إلى أي خدمة أخرى.</p>
              </div>
              <Field label="استيراد Cookies من متصفح محلي (Windows)">
                <select className="bh-input" dir="ltr" value={s.cookiesFromBrowser ?? ""} onChange={(e) => setS({ ...s, cookiesFromBrowser: e.target.value || null })}>
                  <option value="">بدون</option>
                  <option value="chrome">Chrome</option>
                  <option value="edge">Microsoft Edge</option>
                  <option value="firefox">Firefox</option>
                  <option value="brave">Brave</option>
                  <option value="opera">Opera</option>
                  <option value="vivaldi">Vivaldi</option>
                  <option value="safari">Safari</option>
                </select>
              </Field>
              <Field label="أو مسار ملف cookies.txt (Netscape)">
                <input className="bh-input" dir="ltr" placeholder="C:\\Users\\you\\cookies.txt" value={s.cookiesPath ?? ""} onChange={(e) => setS({ ...s, cookiesPath: e.target.value })} />
              </Field>
            </div>
            <Field label="مسار yt-dlp (اختياري)">
              <input className="bh-input" dir="ltr" placeholder="C:\\tools\\yt-dlp.exe" value={s.ytdlpPath ?? ""} onChange={(e) => setS({ ...s, ytdlpPath: e.target.value })} />
            </Field>
            <Field label="مسار gallery-dl (اختياري)">
              <input className="bh-input" dir="ltr" placeholder="/usr/local/bin/gallery-dl" value={s.gallerydlPath ?? ""} onChange={(e) => setS({ ...s, gallerydlPath: e.target.value })} />
            </Field>
            <Field label="مسار ffmpeg (اختياري)">
              <input className="bh-input" dir="ltr" placeholder="C:\\ffmpeg\\bin\\ffmpeg.exe" value={s.ffmpegPath ?? ""} onChange={(e) => setS({ ...s, ffmpegPath: e.target.value })} />
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                يُتحقّق من المسار عند الحفظ: يجب أن يكون ملفاً موجوداً وقابلاً للتنفيذ، وإلا سيُرفض ويُشرح السبب.
              </p>
            </Field>
            <div className="rounded-xl border border-[var(--border)] bg-black/25 p-3 space-y-3">
              <div>
                <p className="text-sm font-semibold">روابط HLS المحمية (Referer / Cookie)</p>
                <p className="text-[11px] text-[var(--muted)]">
                  بعض روابط m3u8 ترفض الطلب (403) إلا بترويسة Referer أو كوكي جلسة. هذه الترويسات تُمرّر إلى محرك N_m3u8DL-RE فقط.
                </p>
              </div>
              <Field label="ترويسات إضافية — سطر لكل ترويسة">
                <textarea
                  className="bh-input font-mono text-xs"
                  dir="ltr"
                  rows={3}
                  placeholder={"Referer: https://example.com/watch\nOrigin: https://example.com"}
                  value={s.hlsHeaders ?? ""}
                  onChange={(e) => setS({ ...s, hlsHeaders: e.target.value })}
                />
              </Field>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-violet-500"
                  checked={s.hlsAutoHeaders ?? true}
                  onChange={(e) => setS({ ...s, hlsAutoHeaders: e.target.checked })}
                />
                <span className="text-sm">
                  استنتاج الترويسات تلقائياً
                  <span className="block text-[11px] text-[var(--muted)]">
                    يفحص: ترويساتك → رابط صفحة المشاهدة (إن وُجد) → نطاق البث نفسه، ويستخدم أول ما يقبله الخادم.
                  </span>
                </span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                <Field label="لغة الصوت الافتراضية">
                  <input
                    className="bh-input"
                    dir="ltr"
                    placeholder="ar"
                    value={s.hlsAudioLang ?? ""}
                    onChange={(e) => setS({ ...s, hlsAudioLang: e.target.value })}
                  />
                </Field>
                <Field label="مدى الفيديو">
                  <select
                    className="bh-input"
                    dir="ltr"
                    value={s.hlsVideoRange ?? ""}
                    onChange={(e) => setS({ ...s, hlsVideoRange: e.target.value || null })}
                  >
                    <option value="">تلقائي</option>
                    <option value="SDR">SDR</option>
                    <option value="HDR">HDR</option>
                    <option value="PQ">PQ</option>
                    <option value="HLG">HLG</option>
                  </select>
                </Field>
                <Field label="الترميز">
                  <select
                    className="bh-input"
                    dir="ltr"
                    value={s.hlsCodecs ?? ""}
                    onChange={(e) => setS({ ...s, hlsCodecs: e.target.value || null })}
                  >
                    <option value="">تلقائي</option>
                    {["avc1", "hvc1", "hev1", "av01", "vp09"].map((codec) => (
                      <option key={codec} value={codec}>
                        {codec}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-violet-500"
                  checked={s.hlsUseCookies ?? true}
                  onChange={(e) => setS({ ...s, hlsUseCookies: e.target.checked })}
                />
                <span className="text-sm">
                  إرسال كوكيز ملف cookies.txt أعلاه إلى محرك HLS
                  <span className="block text-[11px] text-[var(--muted)]">
                    تُفلتر الكوكيز حسب نطاق الرابط فقط (لا تُرسل كوكيز موقع آخر إلى موقع مختلف).
                  </span>
                </span>
              </label>
            </div>
            <div className="flex items-center gap-3">
              <button className="bh-btn bh-btn-primary" disabled={saving} onClick={save}>حفظ الإعدادات</button>
              {msg && <span className="text-xs text-violet-300">{msg}</span>}
            </div>
            {Object.keys(reasons).length > 0 && (
              <ul className="mt-2 space-y-1 rounded-xl border border-amber-700/50 bg-amber-950/30 p-3 text-[11px] text-amber-200">
                {Object.entries(reasons).map(([key, reason]) => (
                  <li key={key}>
                    <code dir="ltr">{key}</code> — {reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}


        <div className="mt-5 rounded-xl border border-[var(--border)] bg-black/30 p-3 text-sm">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">أمان الوصول (رمز الشبكة المحلية)</h3>
            <span className="text-[11px] text-[var(--muted)]">{access?.bind ?? "—"}</span>
          </div>
          {access ? (
            <>
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                {access.publicBind
                  ? "التطبيق يستمع على كل الواجهات، لذلك يُطلب الرمز من أي جهاز آخر. الجهاز نفسه (loopback) لا يحتاج رمزاً."
                  : "التطبيق يستمع على loopback فقط — لا وصول من الشبكة."}{" "}
                المصدر: <code dir="ltr">{access.source}</code>
              </p>
              {access.hasToken ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code
                    dir="ltr"
                    className="flex-1 truncate rounded-lg border border-[var(--border)] bg-black/40 px-2 py-1 text-xs"
                  >
                    {showToken ? access.token : `${"•".repeat(12)}${access.token?.slice(-4) ?? ""}`}
                  </code>
                  <button className="bh-btn bh-btn-ghost text-xs" onClick={() => setShowToken((v) => !v)}>
                    {showToken ? "إخفاء" : "إظهار"}
                  </button>
                  <button className="bh-btn bh-btn-ghost text-xs" onClick={copyToken}>
                    نسخ
                  </button>
                  <button className="bh-btn bh-btn-ghost text-xs" disabled={rotating} onClick={rotateToken}>
                    {rotating ? <Spinner /> : "↻"} تدوير
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-amber-200">
                  لا يوجد رمز (إمّا التطبيق على loopback، أو AUTO_TOKEN معطّل). عيّن BLACKHOLE_TOKEN لتأمين الوصول من الشبكة.
                </p>
              )}
              {access.urls.length > 0 && access.token && (
                <div className="mt-2 space-y-1 text-[11px] text-[var(--muted)]">
                  <p>روابط جاهزة للأجهزة الأخرى:</p>
                  {access.urls.slice(0, 3).map((base) => (
                    <code key={base} dir="ltr" className="block truncate rounded bg-black/40 px-2 py-1">
                      {`${base}/?token=${access.token}`}
                    </code>
                  ))}
                </div>
              )}
              {access.autoTokenDisabled && (
                <p className="mt-2 text-[11px] text-amber-200">التوليد التلقائي معطّل (BLACKHOLE_AUTO_TOKEN=0).</p>
              )}
              {accessMsg && <p className="mt-2 text-[11px] text-violet-300">{accessMsg}</p>}
              <p className="mt-2 text-[11px] text-[var(--muted)]">
                ملف الرمز: <code dir="ltr">{access.tokenFile}</code> (صلاحية 0600). تدوير الرمز يقطع الأجهزة الأخرى فوراً.
              </p>
            </>
          ) : (
            <p className="mt-1 text-[11px] text-[var(--muted)]">…جارٍ قراءة حالة الوصول</p>
          )}
        </div>
        <div className="mt-8 space-y-2 text-xs text-[var(--muted)]">
          <p>🛡 لا إعلانات · لا تتبع · لا حسابات · كل شيء يعمل محلياً على جهازك.</p>
          <p>⚖️ استخدم التطبيق فقط لتحميل المحتوى الذي تملك حق تحميله أو المرخّص لذلك. لا يتجاوز التطبيق أي حماية تقنية (DRM).</p>
        </div>
      </aside>
    </div>
  );
}

function EngineRow({ name, info }: { name: string; info?: { ok: boolean; path: string | null; version: string | null } }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="font-mono">{name}</span>
      {info?.ok ? (
        <span className="truncate text-xs text-emerald-300" dir="ltr" title={info.path ?? ""}>● {info.version}</span>
      ) : (
        <span className="text-xs text-rose-300">● غير موجود</span>
      )}
    </div>
  );
}

function CookiesBox() {
  const [status, setStatus] = useState<{ hasCookies: boolean; count: number; sessions: string[]; path?: string; hint?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<NonNullable<typeof status>>("/api/cookies").then(setStatus).catch(() => null);
  }, []);

  return (
    <div className="space-y-2">
      <div className="text-[11px]">
        {status?.hasCookies ? (
          <span className="text-emerald-300">
            ✓ {status.count} كوكي محفوظ{status.sessions.length ? ` · جلسات: ${status.sessions.join("، ")}` : " · لا توجد جلسة دخول واضحة"}
          </span>
        ) : (
          <span className="text-amber-300">لا توجد كوكيز محفوظة بعد.</span>
        )}
      </div>
      <label className="bh-btn bh-btn-ghost cursor-pointer text-xs">
        ⬆ رفع cookies.txt
        <input
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          disabled={busy}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setMessage(null);
            try {
              const content = await file.text();
              const result = await api<{ count: number; sessions: string[] }>("/api/cookies", {
                method: "POST",
                body: JSON.stringify({ content }),
              });
              setMessage(`تم الحفظ ✓ (${result.count} كوكي · ${result.sessions.length} جلسة)`);
              setStatus(await api("/api/cookies"));
            } catch (e) {
              setMessage(e instanceof Error ? e.message : "فشل الرفع");
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {message && <p className="text-[11px] text-violet-300">{message}</p>}
      {status?.path && <p className="break-all text-[10px] text-[var(--muted)]" dir="ltr">{status.path}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-[var(--muted)]">{label}</div>
      {children}
    </div>
  );
}
