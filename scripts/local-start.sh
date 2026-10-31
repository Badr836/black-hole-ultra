#!/usr/bin/env bash
# تشغيل محلي على macOS / Linux: يثبّت الاعتماديات ويبني ويشغّل على المنفذ 3000
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"
need() { command -v "$1" >/dev/null || { echo "✗ يلزم $1: $2"; exit 1; }; }
need node   "ثبّت Node.js 20+ من https://nodejs.org"
command -v yt-dlp  >/dev/null || echo "! yt-dlp غير موجود — ثبّته: pip install -U yt-dlp"
command -v ffmpeg  >/dev/null || echo "! ffmpeg غير موجود — ثبّته: apt install ffmpeg / brew install ffmpeg"
[[ -d node_modules/next ]] || { echo "▸ تثبيت الاعتماديات"; npm ci --no-audit --no-fund || exit 1; }
[[ -f .next/BUILD_ID ]]    || { echo "▸ بناء الإنتاج";      npm run build        || exit 1; }
echo "▸ تشغيل الخادم على http://localhost:$PORT"
PORT="$PORT" HOSTNAME=0.0.0.0 npm start
