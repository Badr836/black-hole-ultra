#!/usr/bin/env bash
# تهيئة بيئة التشغيل فقط — لا تعدّل كود التطبيق.
set -x
cd /workspaces/black-hole-ultra || exit 1
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg aria2 curl ca-certificates
sudo mkdir -p /app/data && sudo chown -R "$(id -u):$(id -g)" /app/data 2>/dev/null || true
mkdir -p data
npm ci --no-audit --no-fund
pip install --quiet --upgrade yt-dlp gallery-dl || true
npm run build
echo "SETUP_DONE"
