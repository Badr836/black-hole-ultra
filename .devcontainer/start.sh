#!/usr/bin/env bash
# تشغيل الخادم على المنفذ 3000 — إعداد تشغيل فقط.
cd /workspaces/black-hole-ultra || exit 1
export PORT=3000
export HOSTNAME=0.0.0.0
pkill -f "next start" 2>/dev/null || true
mkdir -p data
[ -d .next ] || npm run build
nohup npx next start -H 0.0.0.0 -p 3000 > /tmp/app.log 2>&1 &
sleep 5
curl -s -o /dev/null -w "health:%{http_code}\n" http://127.0.0.1:3000/api/health || true
