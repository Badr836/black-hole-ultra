#!/usr/bin/env python3
"""يولّد أدلة الوصول الحيّة من docs/live.json: رمز QR + بطاقة التثبيت + ملخّص نصّي.

    python3 scripts/live-card.py            # يقرأ docs/live.json
    python3 scripts/live-card.py --url X --short Y
"""
from __future__ import annotations

import argparse
import base64
import json
import pathlib
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
STATE = DOCS / "live.json"


def make_qr(url: str, path: pathlib.Path, size: int = 900) -> None:
    import qrcode
    from qrcode.image.styledpil import StyledPilImage
    from qrcode.image.styles.colormasks import SolidFillColorMask
    from qrcode.image.styles.moduledrawers.pil import RoundedModuleDrawer

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=10, border=3)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(
        image_factory=StyledPilImage,
        module_drawer=RoundedModuleDrawer(),
        color_mask=SolidFillColorMask(back_color=(255, 255, 255), front_color=(30, 10, 60)),
    )
    img.convert("RGB").resize((size, size)).save(path, optimize=True)


CARD = """<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BlackHole Ultra — بطاقة التثبيت</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 32px 16px 56px;
    font-family: "Segoe UI", Tahoma, system-ui, -apple-system, "Noto Sans Arabic", sans-serif;
    background: radial-gradient(1200px 600px at 70% -10%, #2a1060 0%, #0b0616 55%, #06030d 100%);
    color: #ede9fe; line-height: 1.8;
  }}
  .wrap {{ max-width: 880px; margin: 0 auto; }}
  header {{ display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }}
  .ring {{
    width: 62px; height: 62px; border-radius: 50%; flex: 0 0 auto;
    background: radial-gradient(circle at 50% 50%, #000 0 34%, #1a1030 38%, #a855f7 56%, #7c3aed 74%, rgba(168,85,247,0) 78%),
                conic-gradient(from 200deg, #f472b6, #a855f7 35%, transparent 45%);
    box-shadow: 0 0 30px rgba(168,85,247,.55);
  }}
  h1 {{ font-size: clamp(22px, 4vw, 32px); margin: 0; letter-spacing: -.02em; }}
  h1 span {{ background: linear-gradient(90deg, #a78bfa, #f0abfc); -webkit-background-clip: text; background-clip: text; color: transparent; }}
  .sub {{ color: #b9a9e6; font-size: 13px; margin: 2px 0 0; }}
  .card {{
    background: rgba(255,255,255,.045); border: 1px solid rgba(168,85,247,.28);
    border-radius: 20px; padding: 22px; margin-top: 20px;
    box-shadow: 0 18px 50px rgba(0,0,0,.45);
  }}
  .hero {{ display: flex; gap: 26px; align-items: center; flex-wrap: wrap; justify-content: center; text-align: center; }}
  .qr {{ background: #fff; padding: 10px; border-radius: 18px; width: 220px; height: 220px; }}
  .qr img {{ width: 100%; height: 100%; display: block; border-radius: 10px; }}
  .link {{ font-size: clamp(24px, 5vw, 34px); font-weight: 800; color: #e9d5ff; direction: ltr; }}
  a {{ color: #c4b5fd; }}
  .pill {{ display: inline-block; direction: ltr; font-size: 12px; color: #0b0616; background: #a78bfa; border-radius: 999px; padding: 3px 12px; font-weight: 700; }}
  h2 {{ font-size: 17px; margin: 26px 0 6px; color: #d8b4fe; }}
  ol {{ padding-inline-start: 22px; margin: 6px 0 0; }}
  li {{ margin: 4px 0; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }}
  .grid .card {{ margin-top: 0; }}
  kbd {{ font-family: inherit; background: rgba(167,139,250,.16); border: 1px solid rgba(167,139,250,.35);
        border-radius: 7px; padding: 1px 7px; font-size: 13px; }}
  .note {{ font-size: 12.5px; color: #a99bd0; border-top: 1px dashed rgba(168,85,247,.3); margin-top: 22px; padding-top: 14px; }}
  .small-qr {{ width: 108px; height: 108px; background:#fff; padding:6px; border-radius:12px; }}
  .small-qr img {{ width:100%; height:100%; border-radius:6px; display:block; }}
  .stamp {{ font-size: 11.5px; color: #8f7fbb; direction: rtl; }}
  @media print {{
    body {{ background: #fff; color: #111; }}
    .card {{ border-color: #ccc; box-shadow: none; background: #fff; }}
    h1 span {{ color: #6d28d9; -webkit-text-fill-color: #6d28d9; }}
    .sub, .note, .link, h2, .stamp {{ color: #333; }}
    .pill {{ background: #ddd; color: #111; }}
    a {{ color: #333; }}
  }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="ring"></div>
    <div>
      <h1>BlackHole <span>Ultra Downloader</span></h1>
      <p class="sub">مدير تحميل محلي — يعمل الآن عبر HTTPS ويمكن تثبيته كتطبيق</p>
    </div>
  </header>

  <section class="card hero">
    <div class="qr"><img src="data:image/png;base64,{qr_short}" alt="QR الرابط المختصر"></div>
    <div>
      <div class="pill">افتح بالكاميرا أو انقر</div>
      <p class="link" style="margin:10px 0 4px"><a href="{short_url}">{short_label}</a></p>
      <p class="sub" style="direction:ltr">{public_url}</p>
      <p class="sub">الأمر واحد على كل الأجهزة: افتح الرابط ← اضغط «تثبيت»،<br>أو من Safari: مشاركة ← «إضافة إلى الشاشة الرئيسية».</p>
      <p class="stamp">آخر تحديث: {stamp}</p>
    </div>
  </section>

  <div class="grid">
    <section class="card">
      <h2>أندرويد</h2>
      <ol>
        <li>Chrome / Edge / Samsung Internet.</li>
        <li>سيظهر زر <b>⬇ تثبيت التطبيق</b> أعلى الصفحة — اضغطه.</li>
        <li>أو ⋮ ← <b>تثبيت التطبيق</b>.</li>
      </ol>
    </section>
    <section class="card">
      <h2>iPhone / iPad</h2>
      <ol>
        <li>في <b>Safari</b> فقط.</li>
        <li>زر المشاركة ⤴ في الأسفل.</li>
        <li><b>إضافة إلى الشاشة الرئيسية</b> ← إضافة.</li>
      </ol>
    </section>
    <section class="card">
      <h2>Windows / macOS</h2>
      <ol>
        <li>Chrome أو Edge.</li>
        <li>أيقونة <kbd>⊕</kbd> في شريط العنوان.</li>
        <li>أو ⋮ ← «تثبيت BlackHole Ultra…».</li>
      </ol>
    </section>
    <section class="card">
      <h2>بعد التثبيت</h2>
      <ol>
        <li>يفتح بملء الشاشة بأيقونته.</li>
        <li>اختصارات سريعة على الأيقونة.</li>
        <li>صفحة «بلا اتصال» عربية بدل خطأ المتصفح.</li>
      </ol>
    </section>
  </div>

  <section class="card" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
    <div class="small-qr"><img src="data:image/png;base64,{qr_direct}" alt="QR الرابط المباشر"></div>
    <div style="flex:1;min-width:220px">
      <h2 style="margin-top:0">نسخة احتياطية للرابط</h2>
      <p class="sub" style="margin:0">إن توقّف الرابط المختصر، هذا رمز الرابط العام المباشر. النفق مؤقّت بطبيعته:
      عند إعادة تشغيله يتغيّر النطاق — أعد توليد البطاقة بـ <span dir="ltr">bash scripts/tunnel-watch.sh</span>.</p>
    </div>
  </section>

  <p class="note">
    للاستخدام المحلي الدائم على جهازك: <span dir="ltr">npm run build &amp;&amp; npm start</span> ثم
    <span dir="ltr">http://127.0.0.1:3000</span> — والتثبيت يعمل هناك أيضاً.
    شارك الرابط فقط مع من تثق به: التحميلات تُنفَّذ على الجهاز الذي يشغّل الخادم.
  </p>
</div>
</body>
</html>
"""


def render(public_url: str, short_url: str | None) -> dict:
    DOCS.mkdir(parents=True, exist_ok=True)
    make_qr(short_url or public_url, DOCS / "qr-short.png")
    make_qr(public_url, DOCS / "qr-direct.png", 700)

    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    qr_short = base64.b64encode((DOCS / "qr-short.png").read_bytes()).decode()
    qr_direct = base64.b64encode((DOCS / "qr-direct.png").read_bytes()).decode()
    label = (short_url or public_url).replace("https://", "").replace("http://", "")

    (DOCS / "install-card.html").write_text(
        CARD.format(
            qr_short=qr_short,
            qr_direct=qr_direct,
            short_url=short_url or public_url,
            short_label=label,
            public_url=public_url,
            stamp=stamp,
        ),
        encoding="utf-8",
    )

    state = {
        "public_url": public_url,
        "short_url": short_url,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "local_url": "http://127.0.0.1:3000",
    }
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    (DOCS / "live.md").write_text(
        "# حالة الرابط الحيّة\n\n"
        f"- الرابط المختصر: {short_url or '—'}\n"
        f"- الرابط العام: {public_url}\n"
        f"- محلياً: http://127.0.0.1:3000\n"
        f"- آخر تحديث: {stamp}\n\n"
        "> النفق مؤقّت. إن لم يفتح الرابط، شغّل `bash scripts/tunnel-watch.sh` وأعد قراءة هذا الملف.\n",
        encoding="utf-8",
    )
    return state


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url")
    parser.add_argument("--short")
    args = parser.parse_args()

    if args.url:
        state = render(args.url, args.short)
    elif STATE.exists():
        current = json.loads(STATE.read_text(encoding="utf-8"))
        state = render(current["public_url"], current.get("short_url"))
    else:
        print("لا يوجد docs/live.json — مرّر --url", file=sys.stderr)
        return 1

    print(json.dumps(state, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
