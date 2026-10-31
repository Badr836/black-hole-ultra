#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# keep-online.sh — يُبقي BlackHole Ultra متاحاً على رابط HTTPS عام، مع تبديل
# تلقائي بين ثلاثة مزوّدي نفق عند فشل أحدهم.
#
# لماذا؟ شبكة الحاوية/السحابة تقطع أنفاق "بلا حساب" بعد فترة، وبعض المزوّدين
# يخنق الأصول الكبيرة (أيقونة 512KB تفشل ⇒ فشل تثبيت الـPWA). لذلك:
#   1. نجرّب المزوّدين بالترتيب حتى ينجح فحص *كامل* (صحة + بيان + أيقونة 512).
#   2. نراقب كل 40 ثانية؛ 3 إخفاقات متتالية ⇒ ننتقل للمزوّد التالي.
#   3. كل تبديل ينشر رابطاً مختصراً جديداً ويحدّث QR + بطاقة التثبيت + live.json.
#
# الاستخدام:
#   bash scripts/keep-online.sh            # حلقة دائمة (شغّلها في الخلفية)
#   bash scripts/keep-online.sh --once     # فحص/إصلاح مرة واحدة
#   PROVIDERS="lhr cf" bash scripts/keep-online.sh
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
INTERVAL="${INTERVAL:-40}"
PROVIDERS="${PROVIDERS:-lhr cf pinggy}"
CLOUDFLARED="${CLOUDFLARED:-$HOME/bin/cloudflared}"
LOG="docs/keep-online.log"
URLS_FILE="docs/live.json"
mkdir -p docs
ONCE=0; [[ "${1:-}" == "--once" ]] && ONCE=1

log() { printf '%s | %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }
die_ok() { return 0; }

server_up() { curl -fsS -m 4 -o /dev/null "http://127.0.0.1:$PORT/api/health"; }

start_server() {
  log "⚠ الخادم متوقّف — تشغيله"
  PATH="$HOME/.deno/bin:$PATH" PORT="$PORT" HOSTNAME=0.0.0.0 \
    nohup npm start >>/tmp/blackhole-server.log 2>&1 &
  for _ in $(seq 1 40); do server_up && { log "✓ الخادم جاهز"; return 0; }; sleep 0.5; done
  log "✗ تعذّر تشغيل الخادم"
  return 1
}

# ── فحص حقيقي: هل يمكن لهذا الرابط أن يخدم تثبيت PWA فعلاً؟ ──────────────────
# مهم: الفحص من داخل الحاوية غير موثوق — خروج الحاوية إلى الإنترنت يُخنق
# أحياناً فيعيد curl الرمز 000 بينما الرابط سليم تماماً من الخارج. لذلك:
#   • فحص محلي (3 محاولات لكل مورد).
#   • إن فشل المحلي ⇒ فحص من خارج الحاوية عبر r.jina.ai.
#   • لا نبدّل المزوّد إلا إذا فشل الاثنان معاً.
local_check() {
  local url="$1" attempt meta
  for attempt in 1 2 3; do
    curl -fsS -m 12 --retry 2 -o /dev/null "$url/api/health" 2>/dev/null && break
    (( attempt == 3 )) && return 1
    sleep 1
  done
  curl -fsS -m 15 --retry 2 -o /dev/null "$url/manifest.webmanifest" 2>/dev/null || return 1
  for attempt in 1 2 3; do
    meta="$(curl -s -m 25 --retry 1 -o /dev/null -w '%{http_code} %{size_download}' "$url/icons/icon-512.png" 2>/dev/null)"
    [[ "$meta" == 200* ]] && (( ${meta#* } > 30000 )) && return 0
    sleep 2
  done
  return 1
}

external_check() {
  local url="$1" body
  body="$(curl -s -m 45 "https://r.jina.ai/$url/api/health" 2>/dev/null)"
  [[ "$body" == *'"ok":true'* ]] || return 1
  body="$(curl -s -m 45 "https://r.jina.ai/$url/manifest.webmanifest" 2>/dev/null)"
  [[ "$body" == *'icons'* && "$body" == *'standalone'* ]] || return 1
  return 0
}

verify() {
  local url="$1"
  local_check "$url" && return 0
  if external_check "$url"; then
    log "  ⓘ الفحص المحلي فشل لكن الرابط سليم من الخارج — لن أبدّله"
    return 0
  fi
  return 1
}

# ── المزوّدون ────────────────────────────────────────────────────────────────
kill_providers() {
  pkill -x cloudflared 2>/dev/null
  pkill -f "ssh .*-R 80:localhost:$PORT" 2>/dev/null
  pkill -f "ssh .*-R0:localhost:$PORT" 2>/dev/null
  sleep 1
}

provider_lhr() {   # localhost.run — SSH، بلا حساب
  : >/tmp/lhr.log
  nohup ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=25 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    -R "80:localhost:$PORT" nokey@localhost.run >>/tmp/lhr.log 2>&1 &
  local url="" 
  for _ in $(seq 1 40); do
    url="$(grep -Eo 'https://[a-z0-9]+\.lhr\.life' /tmp/lhr.log | head -1 || true)"
    [[ -n "$url" ]] && break; sleep 1
  done
  printf '%s' "$url"
}

provider_cf() {    # Cloudflare quick tunnel
  : >/tmp/cf.log
  nohup "$CLOUDFLARED" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >>/tmp/cf.log 2>&1 &
  local url=""
  for _ in $(seq 1 45); do
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cf.log | head -1 || true)"
    [[ -n "$url" ]] && break; sleep 1
  done
  printf '%s' "$url"
}

provider_pinggy() { # pinggy.io — SSH على 443
  : >/tmp/pinggy.log
  nohup ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=25 -o ExitOnForwardFailure=yes \
    -p 443 -R0:"localhost:$PORT" a.pinggy.io >>/tmp/pinggy.log 2>&1 &
  local url=""
  for _ in $(seq 1 40); do
    url="$(grep -Eo 'https://[a-z0-9-]+\.(a\.free\.)?pinggy\.link' /tmp/pinggy.log | head -1 || true)"
    [[ -n "$url" ]] && break; sleep 1
  done
  printf '%s' "$url"
}

# ── النشر: رابط مختصر جديد + QR + بطاقة + live.json ─────────────────────────
publish() {
  local url="$1" provider="$2" short=""
  local alias="bh-$(date -u +%m%d%H%M)"
  local reply
  reply="$(curl -s -m 20 -X POST https://spoo.me/ -H 'Accept: application/json' \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-urlencode "url=$url" --data-urlencode "alias=$alias" 2>/dev/null || true)"
  short="$(printf '%s' "$reply" | grep -o 'https\?://spoo\.me/[A-Za-z0-9_-]*' | head -1 || true)"
  short="${short/http:\/\//https://}"

  python3 scripts/live-card.py --url "$url" ${short:+--short "$short"} >/dev/null 2>&1 && \
    python3 - "$provider" <<'PY'
import json, sys, pathlib
p = pathlib.Path("docs/live.json")
d = json.loads(p.read_text(encoding="utf-8"))
d["provider"] = sys.argv[1]
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  log "✓ منشور عبر $provider → ${short:-$url}"
  log "  المباشر: $url"
}

# ── المحاولة عبر المزوّدين بالترتيب ─────────────────────────────────────────
bring_up() {
  kill_providers
  local p url
  for p in $PROVIDERS; do
    log "… تجربة المزوّد: $p"
    case "$p" in
      lhr)    url="$(provider_lhr)" ;;
      cf)     url="$(provider_cf)" ;;
      pinggy) url="$(provider_pinggy)" ;;
      *)      continue ;;
    esac
    if [[ -z "$url" ]]; then log "  ✗ لم يرجع رابطاً"; kill_providers; continue; fi
    log "  رابط: $url — جارٍ الفحص الكامل…"
    if verify "$url"; then
      printf '%s\n' "$url" >/tmp/blackhole-tunnel-url.txt
      printf '%s\n' "$p" >/tmp/blackhole-provider.txt
      publish "$url" "$p"
      return 0
    fi
    log "  ✗ فشل الفحص (بطيء أو ناقص) — تجربة مزوّد آخر"
    kill_providers
  done
  return 1
}

log "═══ حارس الاتصال (كل ${INTERVAL}ث · مزوّدون: $PROVIDERS) ═══"
server_up || start_server || exit 1

URL="$(head -1 /tmp/blackhole-tunnel-url.txt 2>/dev/null | tr -d '[:space:]')"
PROVIDER="$(head -1 /tmp/blackhole-provider.txt 2>/dev/null | tr -d '[:space:]')"
if [[ -n "$URL" ]] && verify "$URL"; then
  log "الرابط الحالي سليم: $URL ($PROVIDER)"
else
  bring_up || { log "✗ فشل كل المزوّدين"; [[ $ONCE == 1 ]] && exit 1; }
  URL="$(head -1 /tmp/blackhole-tunnel-url.txt | tr -d '[:space:]')"
  PROVIDER="$(head -1 /tmp/blackhole-provider.txt | tr -d '[:space:]')"
fi

[[ $ONCE == 1 ]] && { log "── فحص واحد انتهى ──"; exit 0; }

fails=0
while true; do
  sleep "$INTERVAL"
  server_up || start_server || true
  if verify "$URL"; then fails=0; continue; fi
  fails=$((fails+1))
  log "⚠ الرابط لا يجتاز الفحص ($fails/3): $URL"
  (( fails < 3 )) && continue
  if bring_up; then
    URL="$(head -1 /tmp/blackhole-tunnel-url.txt | tr -d '[:space:]')"
    PROVIDER="$(head -1 /tmp/blackhole-provider.txt | tr -d '[:space:]')"
    log "↻ تحوّل إلى $PROVIDER — الرابط الجديد: $URL"
  else
    log "✗ تعذّر إيجاد مزوّد صالح — إعادة المحاولة في الدورة القادمة"
  fi
  fails=0
done
