#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# حارس الرابط العام — يُبقي BlackHole Ultra قابلاً للوصول من الإنترنت، ويصلح
# نفسه تلقائياً عندما يسقط نفق Cloudflare (وهو ما يحدث فعلاً: نفق بلا حساب
# يُلغى من طرف Cloudflare بعد فترة خمول، فيصبح اسم النطاق غير موجود).
#
# كل دورة (افتراضياً كل 45 ثانية):
#   1. يتأكد أن خادم Next يعمل، ويشغّله إن سقط.
#   2. يتأكد أن رابط النفق يستجيب فعلياً (‏/api/health = 200).
#   3. إن سقط: يقتل cloudflared، يفتح نفقاً جديداً، يقرأ النطاق الجديد،
#      ينشئ رابطاً مختصراً جديداً، ويعيد توليد QR + بطاقة التثبيت + docs/live.json.
#   4. يسجّل كل شيء في docs/tunnel-watch.log
#
# الاستخدام:
#   bash scripts/tunnel-watch.sh              # يراقب ويصلح (يعمل في المقدمة)
#   bash scripts/tunnel-watch.sh --once       # فحص واحد وإصلاح إن لزم ثم خروج
#   INTERVAL=30 bash scripts/tunnel-watch.sh  # كل 30 ثانية
# ---------------------------------------------------------------------------
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"
INTERVAL="${INTERVAL:-45}"
CLOUDFLARED="${CLOUDFLARED:-$HOME/bin/cloudflared}"
LOG_DIR="${LOG_DIR:-/tmp}"
LOG="docs/tunnel-watch.log"
URL_FILE="$LOG_DIR/blackhole-tunnel-url.txt"
TUNNEL_LOG="$LOG_DIR/blackhole-tunnel.log"
SERVER_LOG="$LOG_DIR/blackhole-server.log"
ONCE=0
[[ "${1:-}" == "--once" ]] && ONCE=1

mkdir -p docs
log() { printf '%s | %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }

server_up() { curl -fsS -m 4 -o /dev/null "http://127.0.0.1:$PORT/api/health"; }

start_server() {
  log "الخادم متوقّف — تشغيله على المنفذ $PORT"
  PATH="$HOME/.deno/bin:$PATH" PORT="$PORT" HOSTNAME=0.0.0.0 \
    nohup npm start >>"$SERVER_LOG" 2>&1 &
  for _ in $(seq 1 40); do server_up && return 0; sleep 0.5; done
  return 1
}

start_tunnel() {
  pkill -x cloudflared 2>/dev/null
  sleep 1
  : >"$TUNNEL_LOG"
  nohup "$CLOUDFLARED" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate \
    >>"$TUNNEL_LOG" 2>&1 &
  local url=""
  for _ in $(seq 1 60); do
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
    [[ -n "$url" ]] && break
    sleep 1
  done
  [[ -n "$url" ]] || { log "✗ فشل إنشاء نفق جديد"; return 1; }
  printf '%s\n' "$url" >"$URL_FILE"
  for _ in $(seq 1 25); do
    curl -fsS -m 8 -o /dev/null "$url/api/health" 2>/dev/null && break
    sleep 1
  done
  printf '%s' "$url"
}

short_link() {
  local url="$1" alias="$2" reply short
  reply="$(curl -s -m 20 -X POST https://spoo.me/ \
      -H 'Accept: application/json' \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-urlencode "url=$url" --data-urlencode "alias=$alias" || true)"
  short="$(printf '%s' "$reply" | grep -o 'https\?://spoo\.me/[A-Za-z0-9_-]*' | head -1 || true)"
  if [[ -z "$short" ]]; then
    reply="$(curl -s -m 20 -X POST https://spoo.me/ -H 'Accept: application/json' \
        -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "url=$url" || true)"
    short="$(printf '%s' "$reply" | grep -o 'https\?://spoo\.me/[A-Za-z0-9_-]*' | head -1 || true)"
  fi
  printf '%s' "${short/http:\/\//https://}"
}

publish() {
  local url="$1"
  local alias
  alias="bh-live-$(date -u +%m%d%H%M)"
  local short
  short="$(short_link "$url" "$alias")"
  if [[ -n "$short" ]]; then
    log "رابط مختصر جديد: $short"
  else
    log "⚠ تعذّر إنشاء رابط مختصر — الرابط المباشر يعمل"
  fi
  python3 scripts/live-card.py --url "$url" ${short:+--short "$short"} >>"$LOG" 2>&1 \
    && log "تم تحديث: docs/qr-short.png · docs/qr-direct.png · docs/install-card.html · docs/live.json"
}

current_ok() {
  local url
  url="$(head -1 "$URL_FILE" 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$url" ]] || return 1
  curl -fsS -m 10 -o /dev/null "$url/api/health" 2>/dev/null || return 1
  printf '%s' "$url"
}

log "═══ بدء حارس الرابط (كل ${INTERVAL}ث) ═══"
server_up || start_server || { log "✗ تعذّر تشغيل الخادم"; exit 1; }

URL="$(current_ok || true)"
if [[ -n "$URL" ]]; then
  log "النفق الحالي يعمل: $URL"
else
  URL="$(start_tunnel)" || exit 1
  log "نفق جديد: $URL"
  publish "$URL"
fi

(( ONCE )) && { log "── فحص واحد انتهى ──"; exit 0; }

failures=0
while true; do
  sleep "$INTERVAL"
  if ! server_up; then
    log "⚠ الخادم سقط — إعادة تشغيل"
    start_server || log "✗ فشل تشغيل الخادم"
  fi
  if curl -fsS -m 10 -o /dev/null "$URL/api/health" 2>/dev/null; then
    failures=0
    continue
  fi
  failures=$((failures + 1))
  log "⚠ الرابط لا يستجيب ($failures/2): $URL"
  (( failures < 2 )) && continue
  NEW="$(start_tunnel)" || { log "✗ فشل النفق الجديد — سأحاول لاحقاً"; failures=0; continue; }
  log "✓ رابط جديد: $NEW (القديم ميت)"
  URL="$NEW"
  failures=0
  publish "$URL"
done
