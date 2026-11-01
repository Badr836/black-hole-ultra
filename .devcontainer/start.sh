#!/usr/bin/env bash
# تشغيل التطبيق على المنفذ 3000 داخل Codespace — إعداد تشغيل فقط، دون أي تعديل على كود التطبيق.
cd /workspaces/black-hole-ultra || exit 1
export PORT=3000 HOSTNAME=0.0.0.0

# انتظر انتهاء بناء postCreate (حتى ساعتين كحد أقصى) قبل التشغيل
for i in $(seq 1 60); do
  [ -f .next/BUILD_ID ] && break
  sleep 10
done
[ -f .next/BUILD_ID ] || npm run build > /tmp/build.log 2>&1

bash .devcontainer/tools.sh >/dev/null 2>&1 || true
pkill -f "next start" 2>/dev/null || true
sleep 1
mkdir -p data
setsid nohup npx next start -H 0.0.0.0 -p 3000 > /tmp/app.log 2>&1 < /dev/null &
echo "$(date -u) started pid $!" >> /tmp/start-history.log
