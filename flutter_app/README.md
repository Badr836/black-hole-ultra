# BlackHole Ultra Downloader — Flutter (Android + Windows)

مدير تحميل محلي قوي بأسلوب IDM يعتمد على **yt-dlp + FFmpeg**، بواجهة داكنة (أسود/بنفسجي)،
بدون إعلانات، بدون تتبع، بدون حسابات.

```
flutter_app/
├─ pubspec.yaml
├─ lib/
│  ├─ main.dart                         ← نقطة البدء، تهيئة SQLite/MediaKit/الخدمات
│  ├─ core/theme.dart                   ← الثيم الداكن (BlackHole)
│  ├─ models/models.dart                ← DownloadTask, MediaInfo, الجودات والصيغ
│  ├─ services/
│  │  ├─ download_engine.dart           ← محرك التحميل (طابور، تزامن، إيقاف/استئناف، إعادة محاولة)
│  │  ├─ settings_service.dart          ← الإعدادات (SharedPreferences)
│  │  ├─ notification_service.dart      ← إشعارات + Foreground Service للأندرويد
│  │  ├─ storage/download_repository.dart ← SQLite (sqflite / sqflite_ffi على ويندوز)
│  │  └─ ytdlp/
│  │     ├─ ytdlp_service.dart          ← واجهة موحّدة + بناء أوامر yt-dlp + تحليل التقدّم
│  │     ├─ ytdlp_process.dart          ← Windows: Process.start(yt-dlp.exe / ffmpeg.exe)
│  │     ├─ ytdlp_android.dart          ← Android: MethodChannel → youtubedl-android
│  │     └─ format_selector.dart        ← بناء -f (دمج الفيديو+الصوت، اختيار الجودة/الصيغة)
│  └─ screens/
│     ├─ home_screen.dart               ← الشاشة الرئيسية
│     ├─ queue_screen.dart              ← طابور التحميل (سرعة، نسبة، حجم، ETA، أزرار التحكم)
│     ├─ player_screen.dart             ← مشغل الوسائط الداخلي (media_kit) + البيانات الوصفية
│     ├─ settings_screen.dart           ← الإعدادات
│     └─ widgets/
│        ├─ add_download_card.dart      ← إدخال الرابط → تحليل → اختيار الجودة/الصيغة
│        └─ blackhole_logo.dart
├─ android/
│  ├─ settings.gradle.kts               ← مستودع JitPack لـ youtubedl-android
│  └─ app/
│     ├─ build.gradle.kts               ← تبعيات youtubedl-android + ffmpeg + aria2c
│     └─ src/main/
│        ├─ AndroidManifest.xml         ← الأذونات (تخزين، إشعارات، Foreground Service)
│        └─ kotlin/com/blackhole/ultradownloader/MainActivity.kt  ← الجسر الأصلي
└─ scripts/
   ├─ fetch_windows_binaries.ps1        ← تنزيل yt-dlp.exe + ffmpeg.exe إلى bin/
   └─ make_installer.iss                ← Inno Setup installer للويندوز
```

---

## 1) المتطلبات

- Flutter 3.22+ (`flutter --version`)
- **Windows**: Visual Studio 2022 مع "Desktop development with C++"
- **Android**: Android Studio + SDK 35 + NDK 27، JDK 17

```bash
flutter doctor
```

## 2) إنشاء ملفات المنصات ثم نسخ ملفاتنا فوقها

هذا المستودع يحتوي ملفات `lib/` والملفات المخصّصة لأندرويد فقط. أنشئ بقية هيكل المنصات مرة واحدة:

```bash
cd flutter_app
flutter create --org com.blackhole --project-name blackhole_ultra_downloader --platforms=android,windows .
# ملاحظة: إذا سأل عن استبدال ملفاتنا (AndroidManifest / build.gradle.kts / MainActivity.kt / pubspec.yaml) اختر "لا" — أو أعد نسخها من git.
git checkout -- pubspec.yaml android/ lib/
flutter pub get
```

> لو كان `flutter create` عندك ينتج `build.gradle` (Groovy) بدلاً من `.kts`، احذف نسخ Groovy وأبقِ ملفات `.kts` المرفقة.

## 3) تشغيل في وضع التطوير

### Windows
```powershell
# نزّل الثنائيات إلى bin/ (يتم نسخها بجانب exe عند البناء)
powershell -ExecutionPolicy Bypass -File scripts/fetch_windows_binaries.ps1
flutter run -d windows
```
أو ثبّتهما نظامياً: `winget install yt-dlp.yt-dlp Gyan.FFmpeg` (التطبيق يبحث في PATH تلقائياً).

### Android
```bash
flutter run -d <device-id>
```
على أندرويد لا تحتاج أي تثبيت: `youtubedl-android` يحزم Python + yt-dlp + FFmpeg داخل الـ APK.
عند أول تشغيل يُطلب إذن التخزين والإشعارات.

## 4) البناء النهائي

### APK (Android)
```bash
flutter build apk --release --split-per-abi        # ينتج arm64-v8a / armeabi-v7a / x86_64
# أو ملف واحد شامل:
flutter build apk --release
# الناتج: build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
```
للتوقيع بمفتاحك الخاص أنشئ `android/key.properties` و`upload-keystore.jks` كما في وثائق Flutter، ثم عدّل `signingConfig` في `build.gradle.kts`.

### Windows — exe + MSIX + Installer
```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch_windows_binaries.ps1
flutter build windows --release
# انسخ الثنائيات بجانب التطبيق:
New-Item -ItemType Directory -Force build\windows\x64\runner\Release\bin | Out-Null
Copy-Item bin\*.exe build\windows\x64\runner\Release\bin\

# (أ) MSIX
dart run msix:create
# الناتج: build\windows\x64\runner\Release\blackhole_ultra_downloader.msix

# (ب) Installer تقليدي (Inno Setup 6)
iscc scripts\make_installer.iss
# الناتج: dist\BlackHoleUltraDownloader-Setup-1.0.0.exe
```

## 5) كيف يعمل التحميل؟

| الميزة | التنفيذ |
|---|---|
| تحليل الرابط | `yt-dlp -J` → قائمة الجودات (144p→8K) والصيغ والترجمات |
| اختيار الجودة/الصيغة | `format_selector.dart` يبني `-f "(bestvideo[height<=H]…)+bestaudio/best"` |
| دمج الفيديو+الصوت | `--merge-output-format mp4|mkv|webm` عبر FFmpeg |
| صوت فقط | `-x --audio-format mp3|m4a|opus|wav|aac|flac --audio-quality 0` |
| قوائم التشغيل | `--yes-playlist` + قالب `%(playlist_index)s - %(title)s` |
| الترجمة | `--write-subs --write-auto-subs --sub-langs ar,en --embed-subs` |
| إيقاف مؤقت/استئناف | قتل العملية مع إبقاء `.part` ثم `--continue` |
| إعادة المحاولة | `--retries 5 --fragment-retries 10` + إعادة على مستوى المحرك (maxRetries) |
| السرعة/النسبة/الحجم | `--progress-template` مخصص يُحلَّل سطرياً |
| التحميل في الخلفية | `flutter_foreground_task` (Android Foreground Service) |
| إشعارات | `flutter_local_notifications` (تقدّم + اكتمال) |
| المشغل الداخلي | `media_kit` (libmpv) — فيديو وصوت + بيانات وصفية + صورة مصغرة |
| التخزين | SQLite محلي (الطابور) + SharedPreferences (الإعدادات) |

## 6) الخصوصية والاستخدام المشروع

- لا توجد أي اتصالات سوى مع الموقع المصدر الذي تطلب التحميل منه (وتحديث yt-dlp عند طلبك صراحة).
- لا إعلانات، لا تحليلات، لا حسابات.
- التطبيق **لا يتجاوز DRM** ولا أي حماية تقنية؛ استخدمه فقط للمحتوى الذي تملك حق تحميله أو المرخّص بذلك.
