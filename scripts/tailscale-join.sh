#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# tailscale-join.sh — يصل حاوية التطبيق بشبكتك الخاصة على Tailscale ثم ينشر
# التطبيق برابط HTTPS ثابت (‏https://<host>.<tailnet>.ts.net) يقبل تثبيت PWA
# من الجوال والكمبيوتر، ولا يعتمد على أي نفق عام.
#
# ما تحتاجه مرة واحدة:
#   1) حساب Tailscale مجاني: https://login.tailscale.com/start
#   2) من لوحة التحكم: DNS ← فعّل "HTTPS Certificates"  (ضروري لشهادة ts.net)
#   3) Settings ← Keys ← Generate auth key  (Reusable = نعم، Expiry = 90 يوماً)
#
# ثم:
#   TSAUTHKEY=tskey-auth-xxxxx bash scripts/tailscale-join.sh
#
# في النهاية يطبع الرابط الجاهز ويحدّث docs/live.json + QR + بطاقة التثبيت.
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

HOSTNAME_TS="${HOSTNAME_TS:-blackhole-ultra}"
PORT="${PORT:-3000}"
SOCK=/var/run/tailscale/tailscaled.sock
STATE=/var/lib/tailscale/tailscaled.state

log() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -n "${TSAUTHKEY:-}" ]] || die "مرّر مفتاح المصادقة: TSAUTHKEY=tskey-auth-… bash scripts/tailscale-join.sh"

command -v tailscale >/dev/null || {
  log "تثبيت Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sudo -n sh || die "فشل التثبيت"
}

# تشغيل الخدمة إن لم تكن تعمل (وضع userspace لا يحتاج صلاحيات شبكة واسعة)
if ! sudo -n tailscale --socket="$SOCK" status >/dev/null 2>&1; then
  log "تشغيل tailscaled (userspace-networking)"
  sudo -n mkdir -p /var/lib/tailscale /var/run/tailscale
  sudo -n nohup tailscaled --tun=userspace-networking \
    --socks5-server=localhost:1055 --state="$STATE" --socket="$SOCK" \
    >/tmp/tailscaled.log 2>&1 &
  for _ in $(seq 1 30); do sudo -n tailscale --socket="$SOCK" status >/dev/null 2>&1 && break; sleep 0.5; done
fi

log "الاتصال بالشبكة (hostname: $HOSTNAME_TS)"
sudo -n tailscale --socket="$SOCK" up \
  --authkey="$TSAUTHKEY" \
  --hostname="$HOSTNAME_TS" \
  --accept-routes=false --accept-dns=false --reset || die "فشل tailscale up (تحقّق من صلاحية المفتاح)"

sleep 2
FQDN="$(sudo -n tailscale --socket="$SOCK" status --json 2>/dev/null \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print((d.get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null)"
[[ -n "$FQDN" ]] || die "لم أحصل على اسم DNS — تأكّد أن MagicDNS مفعّل في لوحة Tailscale"
log "اسم الجهاز في الشبكة: $FQDN"

# تأكيد أن خادم التطبيق يعمل قبل النشر
curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$PORT/api/health" \
  || die "خادم التطبيق لا يعمل على المنفذ $PORT — شغّله أولاً (npm start)"

log "نشر التطبيق على HTTPS عبر Tailscale Serve"
sudo -n tailscale --socket="$SOCK" serve --bg --https=443 "http://127.0.0.1:$PORT" \
  || die "فشل serve — تأكّد من تفعيل HTTPS Certificates في لوحة التحكم"

URL="https://$FQDN"
log "انتظار إصدار الشهادة…"
for _ in $(seq 1 30); do
  curl -fsS -m 8 -o /dev/null "$URL/api/health" 2>/dev/null && break
  sleep 3
done

python3 scripts/live-card.py --url "$URL" --short "$URL" >/dev/null 2>&1 \
  && log "حُدِّثت docs/live.json و docs/qr-short.png و docs/install-card.html"

cat <<EOF

──────────────────────────────────────────────
  الرابط الدائم (Tailscale):
    $URL

  من الجوال أو أي جهاز في شبكتك:
    1) ثبّت تطبيق Tailscale وسجّل الدخول بنفس الحساب.
    2) افتح الرابط أعلاه.
    3) Chrome/Edge: زر «تثبيت التطبيق» · iPhone/Safari: مشاركة ← إضافة إلى الشاشة الرئيسية.
──────────────────────────────────────────────
  ملاحظات:
  • الرابط لا يتغيّر ولا يعتمد على أي خدمة نفق عامة.
  • لإيقاف المشاركة: sudo tailscale serve --https=443 off
  • لإخراج هذا الجهاز من الشبكة: sudo tailscale logout
EOF
