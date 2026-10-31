# من شكوى المستخدم إلى قرار في الكود

كل صف: بلاغ حقيقي برقمه ورابطه ← القرار المتخذ في هذا المستودع ← كيف يُتحقق منه.

| البلاغ | الشكوى | القرار | التحقق |
|---|---|---|---|
| [yt-dlp #15012](https://github.com/yt-dlp/yt-dlp/issues/15012) · [#16766](https://github.com/yt-dlp/yt-dlp/issues/16766) · [#17799](https://github.com/yt-dlp/yt-dlp/issues/17799) | «JS runtime خارجي صار مطلوباً ليوتيوب» | `src/lib/runtimes.ts`: كشف deno/bun/node≥22 وتمرير `--js-runtimes` + تشخيص | تحليل يوتيوب بلا تحذير «deprecated» |
| [yt-dlp #17456](https://github.com/yt-dlp/yt-dlp/issues/17456) · [cobalt #1356](https://github.com/imputnet/cobalt/issues/1356) | 403 Forbidden من يوتيوب | تدوير عميل إلى `android_vr` **بعد الفشل فقط** مع تسجيل السبب | اختبار وحدة + سجل المهمة |
| [yt-dlp #6369](https://github.com/yt-dlp/yt-dlp/issues/6369) · [#1918](https://github.com/yt-dlp/yt-dlp/issues/1918) · Motrix | سرعة تحميل يوتيوب بطيئة / تعدد المسارات | `aria2c` كمُنزِّل خارجي اختياري (`http:aria2c`) | تحميل حقيقي يظهر `Invoking aria2c downloader` |
| [yt-dlp #7271](https://github.com/yt-dlp/yt-dlp/issues/7271) | `--cookies-from-browser` Permission denied | رسالة عربية تشرح تشفير Chrome على ويندوز وإغلاق المتصفح | اختبار وحدة على الرسالة |
| [Seal #736](https://github.com/JunkFood02/Seal/issues/736) | «playlist download not complete» | تسجيل كل الملفات + **تحقق اكتمال** ومقارنة بالعدد المطلوب | اختبار + تحميل قائمة بنطاق |
| [Seal #1161](https://github.com/JunkFood02/Seal/issues/1161) | لا يوجد مجلد مؤقت قابل للاستخدام | مجلد الحفظ يُنشأ ويُفحص قبل البدء برسالة واضحة | موجود من الجولة الأولى |
| التكرار (38 بلاغاً) | إعادة تحميل ما تم تحميله | `--download-archive` اختياري + «تم تخطيه» ليست فشلاً | اختبار وحدة + تشغيل مزدوج |
| SponsorBlock (39 بلاغاً) | تنقية الرعايات | اختياري ومُعطَّل افتراضياً، ومُعلَن أنه يرسل معرّف الفيديو لطرف ثالث | بناء الوسائط + الإعلان في الواجهة |
| Motrix/Gopeed | واجهة وتزامن وحد سرعة | موجود (تزامن 1–8، حد سرعة، إشعارات، إحصاءات) | E2E |
| 4 بلاغات DRM | «ادعموا Netflix/Spotify» | **مرفوض دائماً** ولا يُنفَّذ | `docs/platform-support.md` |
| التحديثات (83 بلاغاً) | «المحرك قديم والموقع تغيّر» | مراقب GitHub + عرض التقادم في التشخيص | `/api/upstream` |
