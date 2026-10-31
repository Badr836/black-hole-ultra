# Tailscale: رابط HTTPS ثابت للتطبيق (بلا نطاق ولا نفق عام)

> الهدف: تفتح **BlackHole Ultra** من جوالك أو أي جهاز، برابط `https://…​.ts.net` ثابت،
> ويقبل التثبيت كتطبيق (PWA). كل شيء يبقى داخل شبكتك الخاصة — لا شيء منشور على الإنترنت.

لماذا Tailscale؟
- شهادة **HTTPS صالحة تلقائياً** بلا شراء نطاق ⇒ شرط أساسي لتثبيت PWA.
- الرابط **لا يتغيّر** ولا يعتمد على أنفاق مجانية تتوقف (كما حدث مع trycloudflare).
- شبكة خاصة مشفّرة: لا أحد غير أجهزتك يصل إلى التطبيق.

---

## الخيار (أ) — أسرع طريقة: اربط هذه الحاوية الآن (رابط يعمل في دقائق)

أحتاج **مفتاح مصادقة** مرة واحدة:

1. أنشئ حساباً مجانياً: <https://login.tailscale.com/start> (Google/GitHub/بريد).
2. من لوحة التحكم: **DNS** ← فعّل **HTTPS Certificates**.
3. **Settings ← Keys ← Generate auth key** → اختر:
   - Reusable: **نعم** (أو لا — لا فرق هنا)
   - Expiry: **90 days**
4. انسخ المفتاح (`tskey-auth-…`) وأرسله لي.

ثم أشغّل:

```bash
TSAUTHKEY=tskey-auth-… bash scripts/tailscale-join.sh
```

فيطبع لك رابطاً مثل `https://blackhole-ultra.tail1a2b3c.ts.net` ويحدّث `docs/live.json`،
QR، وبطاقة التثبيت.

> ⚠️ المفتاح يسمح لذلك الجهاز بالانضمام إلى شبكتك — أرسله في محادثة خاصة،
> وأبطله (Revoke) من اللوحة بعد أن ننتهي: **Settings ← Keys**.
> وملاحظة صريحة: هذا الرابط يبقى حياً ما دامت هذه الحاوية تعمل؛
> للدوام الحقيقي شغّل التطبيق على جهازك (الخيار ب).

---

## الخيار (ب) — الوضع الدائم: على جهازك أنت

هذا هو الاستخدام الصحيح لمدير تحميل: الملفات تُنزَّل على جهازك، والجوال يتحكّم به.

### 1) ثبّت المتطلبات

```powershell
# Windows (PowerShell)
winget install OpenJS.NodeJS.LTS yt-dlp.yt-dlp Gyan.FFmpeg
winget install tailscale.tailscale
```

```bash
# macOS
brew install node yt-dlp ffmpeg && brew install --cask tailscale
# Linux
curl -fsSL https://tailscale.com/install.sh | sh
```

### 2) شغّل التطبيق

```bash
npm ci
npm run build
npm start          # http://localhost:3000
```

### 3) انشر عبر Tailscale (رابط HTTPS ثابت)

```powershell
tailscale up                        # سجّل الدخول أول مرة
tailscale serve --bg 3000           # يطبع https://<اسم-جهازك>.<tailnet>.ts.net
```

- على **Windows**: شغّل PowerShell كمسؤول، أو استخدم أيقونة Tailscale في صينية النظام ← **Serve**.
- أول مرة قد يطلب تفعيل الشهادات: **لوحة التحكم ← DNS ← Enable HTTPS Certificates**، ثم أعد الأمر.

### 4) من الجوال

1. ثبّت تطبيق **Tailscale** (App Store / Google Play) وسجّل الدخول بنفس الحساب.
2. تأكد أن الـVPN مفعّل في التطبيق.
3. افتح الرابط `https://<اسم-جهازك>.<tailnet>.ts.net`.
4. ثبّت التطبيق:
   - **أندرويد (Chrome/Edge)**: زر «⬇ تثبيت التطبيق» أعلى الصفحة.
   - **iPhone (Safari)**: مشاركة ⤴ ← «إضافة إلى الشاشة الرئيسية».

بعد التثبيت يعمل بملء الشاشة، باختصارات سريعة، وصفحة «بلا اتصال» عربية عند انقطاع الشبكة.

---

## الأمان

- التطبيق هنا **لا يحتاج رمز وصول** على نطاق `*.ts.net` (أضفته إلى قائمة السماح لأن الشبكة خاصة أصلاً).
  إن أردت طبقة إضافية: ⚙️ الإعدادات ← أمان الوصول ← تدوير رمز.
- **لا تستخدم `tailscale funnel`** إلا إذا أردت نشره على الإنترنت حقاً؛ عندها فعّل رمز الوصول أولاً.
- لإيقاف المشاركة: `tailscale serve --https=443 off` · لإخراج الجهاز: `tailscale logout`.

---

## حلّ المشكلات

| العرض | السبب | الحل |
|---|---|---|
| `502 Bad Gateway` | التطبيق غير شغّال أو منفذ مختلف | `npm start` ثم `tailscale serve --bg 3000` |
| `certificate not ready` | الشهادة تُصدر أول مرة (~30 ثانية) | انتظر ثم أعد التحميل · `tailscale cert <hostname>.ts.net` |
| `serve: access denied` | HTTPS غير مفعّل في اللوحة | فعّل **HTTPS Certificates** |
| الجوال لا يفتح الرابط | Tailscale غير مفعّل على الجوال | افتح تطبيق Tailscale وتأكد من الاتصال |
| الاسم لا يُحلّ | MagicDNS مغلق | لوحة التحكم ← DNS ← **MagicDNS** |
