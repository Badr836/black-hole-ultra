#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  tunnels-up.sh <provider> — يشغّل نفقاً واحداً ويُبقيه حياً إلى الأبد.
#
#  المزوّدون:  lhr | cf | pinggy | bore
#
#  الفكرة: نحن لا نثق بأن العملية "شغّالة" — بل نفحص الرابط فعلياً كل 20 ثانية
#  (طلب إلى /api/health مع ?cb= عشوائي لتجاوز أي كاش). إن عاد 5xx أو لا رد،
#  نقتل النفق ونفتح غيره تلقائياً، ونحدّث docs/links/<provider>.json بالرابط الحالي.
#
#  التشغيل:  bash scripts/tunnels-up.sh lhr      (كل مزوّد في عملية مستقلة)
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

PROVIDER="${1:?usage: tunnels-up.sh <lhr|cf|pinggy|bore>}"
PORT="${PORT:-3000}"
CLOUDFLARED="${CLOUDFLARED:-$HOME/bin/cloudflared}"
STATE_DIR="docs/links"
LOG="docs/links/${PROVIDER}.log"
mkdir -p "$STATE_DIR"

log() { printf '%s | %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$LOG"; }

write_state() {  # $1 = url, $2 = status
  python3 - "$PROVIDER" "$1" "$2" <<'PY'
import json, sys, pathlib, datetime
provider, url, status = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(f"docs/links/{provider}.json")
p.write_text(json.dumps({
    "provider": provider, "url": url, "status": status,
    "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

health() {  # $1 = url → 0 إذا 200
  local url="$1" code
  code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$url/api/health?cb=$RANDOM$RANDOM" 2>/dev/null)"
  [[ "$code" == "200" ]]
}

start() {
  case "$PROVIDER" in
    lhr)
      : >"/tmp/tun-lhr.log"
      ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
          -o ExitOnForwardFailure=yes -o TCPKeepAlive=yes \
          -R 80:localhost:"$PORT" nokey@localhost.run >"/tmp/tun-lhr.log" 2>&1 &
      echo $! >"/tmp/tun-lhr.pid"
      for _ in $(seq 1 40); do
        URL="$(grep -Eo 'https://[a-z0-9]+\.lhr\.life' /tmp/tun-lhr.log | head -1)"
        [[ -n "${URL:-}" ]] && return 0
        sleep 1
      done
      return 1 ;;
    cf)
      : >"/tmp/tun-cf.log"
      "$CLOUDFLARED" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >"/tmp/tun-cf.log" 2>&1 &
      echo $! >"/tmp/tun-cf.pid"
      for _ in $(seq 1 45); do
        URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/tun-cf.log | head -1)"
        [[ -n "${URL:-}" ]] && return 0
        sleep 1
      done
      return 1 ;;
    pinggy)
      : >"/tmp/tun-pinggy.log"
      ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes \
          -p 443 -R0:localhost:"$PORT" a.pinggy.io >"/tmp/tun-pinggy.log" 2>&1 &
      echo $! >"/tmp/tun-pinggy.pid"
      for _ in $(seq 1 45); do
        URL="$(grep -Eo 'https://[a-z0-9-]+\.(a\.free\.)?pinggy\.link' /tmp/tun-pinggy.log | head -1)"
        [[ -n "${URL:-}" ]] && return 0
        sleep 1
      done
      return 1 ;;
    bore)
      command -v bore >/dev/null || return 1
      : >"/tmp/tun-bore.log"
      bore local "$PORT" --to bore.pub >"/tmp/tun-bore.log" 2>&1 &
      echo $! >"/tmp/tun-bore.pid"
      for _ in $(seq 1 30); do
        URL="$(grep -Eo 'bore\.pub:[0-9]+' /tmp/tun-bore.log | head -1)"
        [[ -n "${URL:-}" ]] && { URL="http://$URL"; return 0; }
        sleep 1
      done
      return 1 ;;
    *) return 1 ;;
  esac
}

kill_tunnel() {
  local pidfile="/tmp/tun-${PROVIDER}.pid"
  [[ -f "$pidfile" ]] && { kill "$(cat "$pidfile")" 2>/dev/null; rm -f "$pidfile"; }
  case "$PROVIDER" in
    cf) pkill -x cloudflared 2>/dev/null ;;
  esac
  sleep 1
}

log "═══ بدء مزوّد $PROVIDER ═══"
fail_streak=0
while true; do
  URL=""
  if ! start || [[ -z "${URL:-}" ]]; then
    log "فشل إنشاء النفق — إعادة بعد 10ث"
    write_state "" "failed"
    kill_tunnel; sleep 10; continue
  fi
  log "رابط جديد: $URL"

  ok=0
  for _ in $(seq 1 12); do
    if health "$URL"; then ok=1; break; fi
    sleep 3
  done
  if (( ! ok )); then
    log "الرابط لا يستجيب بعد 36ث — إعادة إنشاء"
    write_state "$URL" "dead"
    kill_tunnel; continue
  fi
  write_state "$URL" "live"
  log "✓ يعمل: $URL"
  fail_streak=0

  # مراقبة: 3 إخفاقات متتالية ⇒ إعادة إنشاء النفق
  while true; do
    sleep 20
    if health "$URL"; then
      fail_streak=0
      write_state "$URL" "live"
    else
      fail_streak=$((fail_streak+1))
      log "⚠ لا يستجيب ($fail_streak/3)"
      write_state "$URL" "degraded"
      if (( fail_streak >= 3 )); then
        log "إعادة إنشاء النفق"
        write_state "$URL" "dead"
        kill_tunnel
        break
      fi
    fi
  done
done
