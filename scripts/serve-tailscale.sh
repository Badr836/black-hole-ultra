#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  serve-tailscale.sh — نشر BlackHole Ultra على شبكتك الخاصة عبر Tailscale
#  لنظام Linux / macOS (وعلى Windows استخدم START-WINDOWS.bat).
#
#  يعطيك رابطاً دائماً بشهادة HTTPS صالحة:  https://<host>.<tailnet>.ts.net
#  عندها يعمل زر «تثبيت التطبيق» من الجوال والكمبيوتر، والرابط لا يتغيّر.
#
#  الاستخدام:
#     bash scripts/serve-tailscale.sh            # تجهيز + تشغيل + نشر
#     bash scripts/serve-tailscale.sh --serve    # النشر فقط (الخادم يعمل)
#     tailscale serve --https=443 off            # لإيقاف المشاركة
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
BASE="http://127.0.0.1:$PORT"
say()  { printf '\n\033[1;35m▸\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\n  \033[31m✗\033[0m %s\n\n' "$*"; exit 1; }

command -v tailscale >/dev/null || {
  say "تثبيت Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sudo sh || fail "فشل تثبيت Tailscale"
}

# ── تسجيل الدخول ────────────────────────────────────────────────────────────
STATE="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null)"
if [[ "$STATE" != "Running" ]]; then
  say "تسجيل الدخول إلى Tailscale (رابط يفتح في المتصفح مرة واحدة)"
  sudo tailscale up --accept-dns=false || fail "فشل tailscale up"
fi
ok "Tailscale يعمل"

# ── الخادم ──────────────────────────────────────────────────────────────────
if curl -fsS -m 3 -o /dev/null "$BASE/api/health" 2>/dev/null; then
  ok "الخادم يعمل على $BASE"
elif [[ "${1:-}" == "--serve" ]]; then
  fail "الخادم غير شغّال — شغّله أولاً: npm run build && npm start"
else
  say "تشغيل الخادم"
  [[ -d node_modules/next ]] || { say "تثبيت الاعتماديات"; npm ci --no-audit --no-fund || fail "فشل npm ci"; }
  [[ -f .next/BUILD_ID ]] || { say "بناء نسخة الإنتاج"; npm run build || fail "فشل البناء"; }
  PORT="$PORT" HOSTNAME=0.0.0.0 nohup npm start >/tmp/blackhole-server.log 2>&1 &
  for _ in $(seq 1 40); do
    curl -fsS -m 2 -o /dev/null "$BASE/api/health" 2>/dev/null && break
    sleep 0.5
  done
  curl -fsS -m 3 -o /dev/null "$BASE/api/health" 2>/dev/null || fail "لم يستجب الخادم — راجع /tmp/blackhole-server.log"
  ok "الخادم يعمل"
fi

# ── النشر على HTTPS ─────────────────────────────────────────────────────────
say "نشر التطبيق على HTTPS عبر Tailscale Serve"
sudo tailscale serve --bg --https=443 "$BASE" || \
  fail "فشل serve — فعّل «HTTPS Certificates» من لوحة تحكم Tailscale (DNS ← Enable HTTPS)"

FQDN="$(tailscale status --json | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))')"
[[ -n "$FQDN" ]] || fail "لم أقرأ اسم الجهاز — تأكد من تفعيل MagicDNS في لوحة التحكم"

URL="https://$FQDN"
say "انتظار الشهادة…"
for _ in $(seq 1 20); do
  curl -fsS -m 6 -o /dev/null "$URL/api/health" 2>/dev/null && break
  sleep 3
done

python3 scripts/live-card.py --url "$URL" --short "$URL" >/dev/null 2>&1 || true

cat <<EOF

  ──────────────────────────────────────────────
   الرابط الدائم:  $URL
  ──────────────────────────────────────────────
   من الجوال: ثبّت تطبيق Tailscale وسجّل الدخول بنفس الحساب،
   ثم افتح الرابط ← «تثبيت التطبيق».
   محلياً:      $BASE
   إيقاف المشاركة: sudo tailscale serve --https=443 off
EOF
