#!/usr/bin/env bash
# يضمن وجود أدوات التنزيل في مسارات يبحث فيها التطبيق ويُصلح الروابط الرمزية.
# إعداد بيئة تشغيل فقط — لا يعدّل كود التطبيق. قابل للتشغيل المتكرر بأمان.
set -u
APP=/workspaces/black-hole-ultra
LOG=/tmp/tools.log
log(){ echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG"; }

# 1) أدوات النظام (ffmpeg/ffprobe/aria2c)
for b in ffmpeg ffprobe aria2c; do
  command -v "$b" >/dev/null || { log "apt install $b"; sudo apt-get install -y -qq ffmpeg aria2 >/dev/null 2>&1; }
done

# 2) yt-dlp / gallery-dl: ثبّتهما إن غابا، ثم اربطهما في /usr/local/bin
mkdir -p "$HOME/.local/bin"
for py in yt-dlp gallery-dl; do
  if ! command -v "$py" >/dev/null; then log "pip install $py"; pip install --quiet --upgrade "$py" || true; fi
  src=$(command -v "$py" 2>/dev/null || true)
  [ -n "$src" ] && sudo ln -sf "$src" "/usr/local/bin/$py" && log "linked $py -> $src"
done

# 3) N_m3u8DL-RE (دمج بث HLS) — يُحمَّل عند غيابه فقط
mkdir -p "$APP/bin"
if [ ! -x "$APP/bin/N_m3u8DL-RE" ]; then
  url=$(curl -s https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest \
        | grep -o 'https://[^"]*linux-x64[^"]*\.tar\.gz' | head -1)
  if [ -n "${url:-}" ]; then
    log "downloading N_m3u8DL-RE"
    tmp=$(mktemp -d)
    if curl -sL "$url" -o "$tmp/a.tgz" && tar xzf "$tmp/a.tgz" -C "$tmp"; then
      f=$(find "$tmp" -type f -name 'N_m3u8DL-RE' | head -1)
      [ -n "$f" ] && install -m 755 "$f" "$APP/bin/N_m3u8DL-RE" && log "installed N_m3u8DL-RE"
    fi
    rm -rf "$tmp"
  else
    log "N_m3u8DL-RE: تعذّر إيجاد الرابط (تخطّي)"
  fi
fi

# 3b) Deno: محرك JavaScript الذي يحتاجه yt-dlp لفكّ تحديات يوتيوب (EJS).
#     بدونه يحذّر yt-dlp بأن الاستخراج «مهجور» وقد تنقص صيغ. مجاني ومفتوح المصدر.
if ! command -v deno >/dev/null; then
  log "installing deno"
  durl=$(curl -s https://api.github.com/repos/denoland/deno/releases/latest \
         | grep -o 'https://[^"]*x86_64-unknown-linux-gnu.zip' | head -1)
  if [ -n "${durl:-}" ]; then
    tmpd=$(mktemp -d)
    if curl -sSL "$durl" -o "$tmpd/deno.zip"; then
      command -v unzip >/dev/null || sudo apt-get install -y -qq unzip >/dev/null 2>&1
      (cd "$tmpd" && unzip -o -q deno.zip) && sudo install -m 755 "$tmpd/deno" /usr/local/bin/deno && log "deno installed"
    fi
    rm -rf "$tmpd"
  fi
fi
command -v deno >/dev/null && log "deno $(deno --version | head -1)"

# 4) ملخّص
for b in yt-dlp gallery-dl ffmpeg ffprobe aria2c; do printf '%s=%s ' "$b" "$(command -v "$b" || echo MISSING)" | tee -a "$LOG"; done
echo | tee -a "$LOG"
echo "nm3u8=$( [ -x "$APP/bin/N_m3u8DL-RE" ] && echo OK || echo MISSING )" | tee -a "$LOG"
