#!/usr/bin/env bash
# تشغيل الخادم على المنفذ 3000 — إعداد تشغيل فقط، لا تعديل على كود التطبيق.
cd /workspaces/black-hole-ultra || exit 1
export PORT=3000 HOSTNAME=0.0.0.0
pkill -f "next start" 2>/dev/null || true
sleep 1
mkdir -p data
[ -d .next ] || npm run build > /tmp/build.log 2>&1
setsid nohup npx next start -H 0.0.0.0 -p 3000 > /tmp/app.log 2>&1 < /dev/null &
disown 2>/dev/null || true
echo "start.sh launched pid $!"
