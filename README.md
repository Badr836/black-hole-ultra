# BlackHole Ultra Downloader

مدير تحميل **محلي أولاً** بأسلوب IDM، يعتمد على `yt-dlp` + `FFmpeg`، بواجهة عربية داكنة
(أسود/بنفسجي)، بلا إعلانات وبلا تتبع وبلا حسابات، وقاعدة بيانات **SQLite** مدمجة.

> استخدم التطبيق فقط للمحتوى الذي تملك حق تحميله أو المرخّص لك تحميله.
> التطبيق لا يتجاوز DRM ولا أي حماية تقنية.

---

## التشغيل في 60 ثانية

```bash
# 1) المحركات (خارج المشروع)
#    Windows:  winget install yt-dlp.yt-dlp Gyan.FFmpeg
#    Linux:    pip install -U "yt-dlp[default,curl-cffi]" && sudo apt install ffmpeg
#    macOS:    brew install yt-dlp ffmpeg
#    أو ضع yt-dlp و ffmpeg و ffprobe في مجلد bin/

# 2) التطبيق
npm install
npm run dev            # http://localhost:3000
```

**أسهل طريقة على Windows:** انقر مرتين على `START-LOCAL.bat` — يثبّت الناقص ويبني ويشغّل ويفتح المتصفح.
على macOS/Linux: `bash scripts/local-start.sh`.

**لا حاجة إلى PostgreSQL، ولا إلى `drizzle-kit push`، ولا إلى ملف `.env`.**
ملف القاعدة `data/blackhole.db` يُنشأ ويُهاجَر تلقائياً عند أول تشغيل.

للإنتاج المحلي:

```bash
npm run build && npm start
```

## البوابات (يجب أن تنجح كلها قبل أي اعتماد)

```bash
npm run typecheck      # TypeScript صارم
npm run lint           # ESLint
npm test               # 55+ اختبار وحدة (node:test)
npm run build          # بناء Next.js
npm run test:e2e       # فحص حقيقي ضد خادم يعمل (يقفز نفسه بلا شبكة)
npm run test:ui        # فحص الواجهة في متصفح حقيقي + لقطات
npm run test:browsers  # Chromium + Firefox + WebKit + مصفوفة أجهزة + حكم التثبيت (PWA)
npm run verify         # كل ما سبق عدا e2e/ui/browsers
```

## تثبيته كتطبيق (PWA) ومشاركته برابط

- يحتاج **HTTPS** (أو `localhost`) — وقتها يظهر زر «⬇ تثبيت التطبيق» في Chrome/Edge،
  وعلى iPhone: Safari ← مشاركة ← «إضافة إلى الشاشة الرئيسية».
- البيان: `/manifest.webmanifest` · الـService Worker: `/sw.js` (لا يخزّن `/api/*` أبداً).
- نشر عام بأمر واحد (بناء + خادم + نفق HTTPS + رابط مختصر + QR):

```bash
bash scripts/share.sh
```

النتائج والأدلة الكاملة: `docs/round6-deploy.md` · بطاقة تثبيت قابلة للطباعة: `docs/install-card.html`.

### رابط HTTPS دائم بلا نطاق (Tailscale)

```text
Windows:        انقر مرتين على START-WINDOWS.bat  → https://<جهازك>.<شبكتك>.ts.net
macOS / Linux:  bash scripts/serve-tailscale.sh
```

الدليل الكامل: `docs/one-click.md` · على جهازك مباشرة: `docs/tailscale.md`.
(لا يعمل Tailscale داخل حاوية التطوير: لوحة تحكّمه محجوبة من شبكتها — مثبت في `docs/round6-deploy.md`.)

## ثلاثة محرّكات لا محرك واحد

| المحرك | يغطي | التثبيت |
|---|---|---|
| **yt-dlp** | يوتيوب، فيسبوك، ديلي موشن، ساوند كلاود، تيك توك، Vimeo، ملفات مباشرة… | `pip install -U "yt-dlp[default,curl-cffi]"` |
| **gallery-dl** | إنستغرام، X/Twitter، Pinterest، ريديت، Pixiv، DeviantArt، Tumblr — منشورات وصور | `pip install -U gallery-dl` |

التوجيه تلقائي حسب الرابط، وهناك **تحويل تلقائي** إذا لم يفهم المحرك الأول الرابط.
المواقع التي تشترط تسجيل دخول (إنستغرام/ريديت/Vimeo) تعمل عبر **مدير الكوكيز** في الإعدادات
(رفع `cookies.txt` بصيغة Netscape + تقرير يوضح المنصات المغطاة).
المحتوى المحمي بـ DRM غير مدعوم ولن يُضاف — راجع `docs/platform-support.md`.

```bash
npm run upstream:check    # أحدث إصدارات المحركات على GitHub
npm run upstream:update   # تحديث المحركات
```

## محرك JavaScript ليوتيوب (مهم)

يوتيوب صار يحتاج محرك JavaScript لحل تحديات التشغيل. التطبيق يكتشفه تلقائياً
(`deno` ثم `bun` ثم `node` 22+) ويمرّره كـ`--js-runtimes`، ويعرض حالته في التشخيص:

```bash
# Linux/macOS — الأسرع والأخف
curl -fsSL https://deno.land/install.sh | sh
# Windows
winget install DenoLand.Deno
```

### مزوّد HLS الاختياري (N_m3u8DL-RE)

لبث `m3u8` المحمي بترويسات/كوكيز. الأداة مرخّصة **MIT** وتُشغَّل كثنائي خارجي (لا كود منسوخ):

```bash
# نزّل إصدار linux-x64 (أو win-x64) من صفحة الإصدارات وضعه في مجلد bin/
# https://github.com/nilaoda/N_m3u8DL-RE/releases
mv N_m3u8DL-RE bin/ && chmod +x bin/N_m3u8DL-RE
```

بدونها يعمل التطبيق كما هو؛ يظهر في التشخيص كـ«غير مثبّت» بدل أن يبدو مفعّلاً.

بدون محرك صالح تعمل التحميلات عادةً لكن قد تنقص جودات أو تظهر رسالة `HTTP 403`.
Node 20 مرفوض من yt-dlp نفسه؛ استخدم Node 22+ أو Deno.

## المزايا

- تحليل الرابط وعرض كل الجودات (144p → 8K) والصيغ والترجمات قبل التحميل.
- **روابط الملفات المباشرة** (mp4/mp3/HLS) مدعومة حتى إن لم يعلن المستخرِج أي ترميز.
- فيديو: MP4 / MKV / WEBM بدمج أفضل صوت تلقائياً — صوت: MP3 / M4A / OPUS / WAV / AAC / FLAC / WMA.
- طابور متزامن، إيقاف مؤقت، استئناف (`.part` + `--continue`)، إعادة محاولة، حد سرعة.
- **قوائم التشغيل**: تنزيل القائمة كاملة أو تحديد نطاق (`1-5,8,12-14`) عبر `--playlist-items`،
  وتسجيل **كل** ملف أنتجه العنصر لا الأخير فقط.
- سرعة/نسبة/حجم/ETA لحظياً، إشعارات عند الاكتمال، مشغّل داخلي بتدفّق مدعوم بـ Range.
- تشخيص شامل: المحركات، عدد المستخرجات، دعم انتحال المتصفح، صلاحية مجلد الحفظ، المساحة الحرة، إصدار المخطط.
- نسخ احتياطي/استعادة للإعدادات (JSON)، حذف الملف من القرص، إحصاءات المكتبة.
- **كشف الحظر (429)** فوراً بدل الانتظار، و**watchdog** لأي مهمة تتوقف عن إنتاج مخرجات.
- مراقب تحديثات المحركات من GitHub (`/api/upstream` + أوامر CLI).
- وضع شبكة محلية اختياري: `BLACKHOLE_TOKEN` + `BLACKHOLE_STRICT_ORIGIN`.
- **الجولة الثانية (مبنية على 175 بلاغ مستخدم من GitHub):**
  - كشف محرك JavaScript تلقائياً + تمريره (yt-dlp #15012/#16766/#17799).
  - تدوير عميل يوتيوب إلى `android_vr` **بعد الفشل فقط** وبتسجيل السبب (yt-dlp #17456، cobalt #1356).
  - منزّل خارجي `aria2c` اختياري عبر `http:aria2c` (لا يلمس DASH/HLS) + تقدّم من حجم `.part`.
  - أرشيف تحميل لكل مجلد: «تم تخطيه» ليست «فشلاً» (38 بلاغ تكرار).
  - SponsorBlock اختياري، مُعطّل افتراضياً، ومُعلَن أنه طرف ثالث.
  - تحقق اكتمال القوائم: تنبيه «X من Y» بدل النجاح الصامت (Seal #736).
  - رسالة عربية واضحة لأخطاء صلاحيات كوكيز المتصفح (yt-dlp #7271).
  - عدد المقاطع المتوازية صار إعداداً (1–16) بدل ثابت 8.
  - التشخيص يعرض: المحركات، حالة كل ميزة، إحصاء المزوّدات، وتقادم المحركات.
- **الجولة الثالثة (سلامة القوائم + مزوّد HLS ثالث):**
  - **تحقق اكتمال القوائم رقمياً**: مقارنة ما طُلب بما حُفظ فعلياً، ومَن فشل ولماذا.
  - **«إعادة الناقص»**: تحميل الفهارس الناقصة وحدها (`--playlist-items 2,5-6`)، بحد أقصى محاولتين.
  - الفشل الجزئي لقائمة = `completed` + تنبيه، لا `failed`؛ والملفات السابقة لا تُمحى من السجل.
  - **N_m3u8DL-RE** (MIT، ثنائي خارجي) كمزوّد ثالث لروابط `.m3u8` المحمية بجلسة، ويُستدعى تلقائياً عند فشل yt-dlp على HLS.
  - **رفض DRM مُبرمَج**: فحص المانيفست قبل التنزيل (`SAMPLE-AES`/Widevine/PlayReady/FairPlay) وإيقاف المهمة برسالة.
  - فشل 404/403 على HLS يُكتشف ويُبلَّغ في **~2 ثانية** بدلاً من ~50.

## الأمان والخصوصية

| البند | السلوك الافتراضي |
|---|---|
| التحقق من شهادة TLS | **مُفعّل**. تعطيله إعداد صريح `allowInsecureTls` للمستخدم خلف وسيط شركة. |
| مجلد الحفظ | يجب أن يكون داخل جذور مسموحة (`DOWNLOAD_DIR`، `~/Downloads`، المنزل، `/tmp`، أو المسار المحفوظ في الإعدادات). |
| قالب اسم الملف | تُجرَّد منه المسارات و`..` حتى لا يفلت من مجلد الحفظ. |
| خدْم الملفات | يُتحقق أن الملف داخل جذور مسموحة بعد `realpath` (لا symlink للخارج، لا NFS). |
| Range | محلّل صارم: مدى شاذ → `416` لا `500`. |
| السجلات | تُحجب الكوكيز والترويسات ورموز الاستعلام قبل التخزين. |
| الشبكة | بلا مصادقة على loopback. عند الفتح للشبكة المحلية اضبط `BLACKHOLE_TOKEN`. |

## بنية المشروع

```
src/lib/engine.ts            محرك الطابور: استحواذ ذرّي، كتابات متسلسلة، إدارة العمليات
src/lib/job-writer.ts        طابور كتابة لكل مهمة + حارس رتابة (يمنع سباق الحالة)
src/lib/analyzer.ts          تحليل yt-dlp + كاش + حدّ تزامن
src/lib/analyzer-normalize.ts تطبيع الصيغ (نقي وقابل للاختبار) + مسار الملف المباشر
src/lib/format-selector.ts   بناء محدد الصيغة + هل تحتاج FFmpeg فعلاً
src/lib/safe-path.ts         تحقق المسارات والجذور المسموحة وتنظيف القالب
src/lib/http-range.ts        محلّل Range صارم
src/lib/site-options.ts      توافق المواقع + فحص قدرة انتحال المتصفح (مع كاش)
src/lib/log-redact.ts        حجب الأسرار من السجلات
src/db/migrations.ts         هجرات مرقّمة تُطبَّق داخل معاملة
src/db/schema.ts             مخطط Drizzle/SQLite
tests/                       اختبارات وحدة + e2e + ui-smoke
docs/agents/                 دورة الوكلاء الثلاثة (باني / ناقد / حكم)
docs/qa-report.md            تقرير الفحص النهائي
```

نسخة Flutter الأصلية موجودة في `flutter_app/` (ويب + أندرويد + ويندوز). لا تحتاج Flutter SDK إلا لإعادة البناء.

### تطبيق أندرويد (APK جاهز)

- تنزيل مباشر: <https://github.com/Badr836/black-hole-ultra/releases/tag/v1.0.0-android>
  (`app-arm64-v8a-release.apk` لأغلب الهواتف، و`app-release.apk` شامل لكل المعماريات).
- عند اكتمال أي فيديو ينسخه التطبيق إلى `Movies/BlackHole` ويظهر في **معرض أندرويد**
  عبر MediaStore (`GallerySaver.kt`)، على Android 10+ بـ `RELATIVE_PATH`+`IS_PENDING`،
  وعلى Android 7–9 بـ `MediaScannerConnection`. لا يُحذف الملف الأصلي إلا بعد التحقق من النسخة.
- إعادة البناء: `cd flutter_app && flutter pub get && flutter build apk --release`
  (JDK 17، Android SDK 36، AGP 8.11.1، Kotlin 2.2.20 — كلها مضبوطة في `android/`).

### التقارير

في `docs/reports/`: ترقية المحرك، إصلاح يوتيوب، تكامل معرض أندرويد، الحالة العامة.

## الترخيص والاعتماديات

يعتمد المشروع على `yt-dlp` (Unlicense)، `FFmpeg` (LGPL/GPL حسب البناء)، `Next.js` (MIT)،
`better-sqlite3` (MIT). أحتفظ بإشعارات الطرف الثالث في أي توزيعة.
راجع `docs/github-research.md` للمشاريع التي دُرست أفكارها (Seal، YTDLnis، Gopeed، Motrix، cobalt)
— لم يُنسخ أي كود منها، ورخصها GPL/AGPL تمنع ذلك بلا التزام.
