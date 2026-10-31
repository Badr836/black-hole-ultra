#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# نشر BlackHole Ultra على رابط HTTPS عام + رابط مختصر + QR.
#
#   ./scripts/share.sh                # بناء + تشغيل + نفق + رابط مختصر + QR
#   ./scripts/share.sh --no-build     # إعادة استخدام بناء موجود
#
# ما يفعله بالترتيب:
#   1. يبني نسخة الإنتاج (next build) — تُتخطّى مع --no-build.
#   2. يشغّل الخادم على 127.0.0.1:3000 (لا يوقفه إن كان يعمل أصلاً).
#   3. يفتح نفق Cloudflare سريع (بدون حساب) → رابط https عام.
#      HTTPS شرط أساسي لكي يقبل المتصفح تثبيت الـPWA وعمل الـService Worker.
#   4. ينشئ رابطاً مختصراً على spoo.me بالاسم المطلوب (SHORT_ALIAS).
#   5. يولّد رمز QR للرابط المختصر في docs/qr-short.png.
#
# المتغيّرات: PORT (3000) · SHORT_ALIAS (bh-ultra) · NO_SHORT=1 لتخطّي الاختصار.
# ملاحظة مهمّة: نفق Cloudflare السريع مؤقّت — اسم النطاق يتغيّر مع كل تشغيل،
# لذا بعد إعادة التشغيل أعد توجيه الرابط المختصر (السكربت يفعل ذلك تلقائياً).
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"
SHORT_ALIAS="${SHORT_ALIAS:-bh-ultra}"
CLOUDFLARED="${CLOUDFLARED:-$HOME/bin/cloudflared}"
LOG_DIR="${LOG_DIR:-/tmp}"
BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

step() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }

# 1 ─ بناء -------------------------------------------------------------------
if (( BUILD )); then
  step "بناء نسخة الإنتاج"
  npm run build
fi

# 2 ─ الخادم ----------------------------------------------------------------
if curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  step "الخادم يعمل بالفعل على المنفذ $PORT — لن أشغّل نسخة ثانية"
else
  step "تشغيل الخادم على 127.0.0.1:$PORT"
  PATH="$HOME/.deno/bin:$PATH" PORT="$PORT" HOSTNAME=0.0.0.0 \
    nohup npm start >"$LOG_DIR/blackhole-server.log" 2>&1 &
  for _ in $(seq 1 40); do
    curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
    || { echo "✗ الخادم لم يبدأ. راجع $LOG_DIR/blackhole-server.log"; exit 1; }
fi

# 3 ─ النفق -----------------------------------------------------------------
if [[ ! -x "$CLOUDFLARED" ]]; then
  step "تنزيل cloudflared"
  mkdir -p "$(dirname "$CLOUDFLARED")"
  curl -fsSL -o "$CLOUDFLARED" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$CLOUDFLARED"
fi

step "فتح نفق HTTPS عام"
PUBLIC_URL=""
URL_FILE="$LOG_DIR/blackhole-tunnel-url.txt"
# إعادة استخدام نفق حيّ بدل فتح نفق جديد (نفق جديد = نطاق جديد = رابط مختصر مكسور).
if [[ -s "$URL_FILE" ]]; then
  CANDIDATE="$(head -1 "$URL_FILE" | tr -d '[:space:]')"
  if curl -fsS -m 8 -o /dev/null "$CANDIDATE/api/health" 2>/dev/null; then
    PUBLIC_URL="$CANDIDATE"
    echo "  يوجد نفق حيّ بالفعل — سأعيد استخدامه: $PUBLIC_URL"
  fi
fi

if [[ -z "$PUBLIC_URL" ]]; then
  : >"$LOG_DIR/blackhole-tunnel.log"
  nohup "$CLOUDFLARED" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate \
    >"$LOG_DIR/blackhole-tunnel.log" 2>&1 &
  for _ in $(seq 1 60); do
    PUBLIC_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_DIR/blackhole-tunnel.log" | head -1 || true)"
    [[ -n "$PUBLIC_URL" ]] && break
    sleep 1
  done
  [[ -n "$PUBLIC_URL" ]] || { echo "✗ لم يظهر رابط النفق. راجع $LOG_DIR/blackhole-tunnel.log"; exit 1; }
  printf '%s\n' "$PUBLIC_URL" >"$URL_FILE"
fi

# 4 ─ التأكد أن الرابط العام يستجيب فعلاً ------------------------------------
step "التحقّق من الرابط العام"
OK=0
for _ in $(seq 1 20); do
  if curl -fsS -m 8 -o /dev/null "$PUBLIC_URL/api/health" 2>/dev/null; then OK=1; break; fi
  sleep 1
done
(( OK )) || { echo "✗ الرابط العام لا يستجيب بعد دقيقة. راجع سجل النفق."; exit 1; }

# 5 ─ الرابط المختصر --------------------------------------------------------
SHORT_URL=""
if [[ "${NO_SHORT:-0}" != "1" ]]; then
  step "إنشاء رابط مختصر (spoo.me/$SHORT_ALIAS)"
  REPLY_JSON="$(curl -s -m 20 -X POST https://spoo.me/ \
      -H 'Accept: application/json' \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-urlencode "url=$PUBLIC_URL" \
      --data-urlencode "alias=$SHORT_ALIAS" || true)"
  SHORT_URL="$(printf '%s' "$REPLY_JSON" | grep -o 'https\?://spoo\.me/[A-Za-z0-9_-]*' | head -1 || true)"

  # الاسم محجوز من تشغيل سابق (نطاق النفق القديم) → رابط عشوائي بديل صالح فوراً.
  if [[ -z "$SHORT_URL" ]]; then
    echo "⚠ الاسم «$SHORT_ALIAS» محجوز من تشغيل سابق (نفق قديم). سأنشئ اسماً بديلاً."
    REPLY_JSON="$(curl -s -m 20 -X POST https://spoo.me/ \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode "url=$PUBLIC_URL" || true)"
    SHORT_URL="$(printf '%s' "$REPLY_JSON" | grep -o 'https\?://spoo\.me/[A-Za-z0-9_-]*' | head -1 || true)"
  fi

  if [[ -z "$SHORT_URL" ]]; then
    echo "⚠ تعذّرت خدمة الاختصار. استخدم الرابط العام مباشرة."
    echo "  الردّ: $REPLY_JSON"
  else
    SHORT_URL="${SHORT_URL/http:\/\//https://}"
    # تأكيد أن الاختصار يوجّه فعلاً إلى هذا النفق
    FINAL="$(curl -s -o /dev/null -m 20 -w '%{redirect_url}' "$SHORT_URL" || true)"
    if [[ -n "$FINAL" && "$FINAL" != "$PUBLIC_URL"* ]]; then
      echo "⚠ الاختصار $SHORT_URL يوجّه إلى $FINAL وليس إلى النفق الحالي."
    fi
    printf '%s\n' "$SHORT_URL" >"$LOG_DIR/blackhole-short-url.txt"
  fi
fi

# 6 ─ رمز QR ----------------------------------------------------------------
TARGET="${SHORT_URL:-$PUBLIC_URL}"
step "توليد رمز QR"
if python3 -c "import qrcode" 2>/dev/null; then
  python3 - "$TARGET" <<'PY'
import sys, qrcode
from qrcode.image.styledpil import StyledPilImage
from qrcode.image.styles.moduledrawers.pil import RoundedModuleDrawer
from qrcode.image.styles.colormasks import SolidFillColorMask
url = sys.argv[1]
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=10, border=3)
qr.add_data(url); qr.make(fit=True)
img = qr.make_image(image_factory=StyledPilImage, module_drawer=RoundedModuleDrawer(),
                    color_mask=SolidFillColorMask(back_color=(255,255,255), front_color=(30,10,60)))
img.convert("RGB").resize((900, 900)).save("docs/qr-short.png", optimize=True)
print("  docs/qr-short.png ←", url)
PY
else
  echo "  (ثبّت qrcode: pip install qrcode pillow) — تم تخطّي QR"
fi

cat <<EOF

──────────────────────────────────────────────
  التطبيق عام الآن ويعمل عبر HTTPS:
    $PUBLIC_URL
  الرابط المختصر:
    ${SHORT_URL:-—}
  رمز QR: docs/qr-short.png
──────────────────────────────────────────────
  أوقف النفق بـ: pkill -f 'cloudflared tunnel'
  إعادة التشغيل تُنشئ نطاقاً جديداً — أعد تشغيل هذا السكربت لتحديث الاختصار.
EOF
