# ---------------------------------------------------------------------------
#  BlackHole Ultra — تشغيل بنقرة واحدة على Windows + رابط HTTPS دائم (Tailscale)
#
#  ما يفعله:
#    1) يتأكد من وجود Node.js و yt-dlp و FFmpeg و Tailscale (وينصّب الناقص عبر winget).
#    2) ينصّب اعتماديات المشروع ويبني نسخة الإنتاج.
#    3) يشغّل الخادم على 127.0.0.1:3000.
#    4) ينشر التطبيق على شبكتك الخاصة عبر Tailscale Serve (شهادة HTTPS صالحة).
#    5) يطبع الرابط النهائي ويفتحه في المتصفح.
#
#  التشغيل:  انقر مرتين على START-WINDOWS.bat   (أو: powershell -ExecutionPolicy Bypass -File scripts\windows-start.ps1)
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Say([string]$text) { Write-Host ""; Write-Host "  $text" -ForegroundColor Magenta }
function Ok([string]$text)   { Write-Host "  ✓ $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fail([string]$text) { Write-Host ""; Write-Host "  ✗ $text" -ForegroundColor Red; Write-Host ""; Read-Host "  اضغط Enter للخروج"; exit 1 }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$port = 3000
$base = "http://127.0.0.1:$port"

Say "BlackHole Ultra — التجهيز الكامل"
Write-Host "  المجلد: $root"

# ── 1) الأدوات ──────────────────────────────────────────────────────────────
function Ensure-Winget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "winget غير متوفّر. حدّث «مثبّت التطبيقات» من Microsoft Store ثم أعد المحاولة."
  }
}

function Ensure-Tool([string]$cmd, [string]$pkg, [string]$label) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Ok "$label موجود"; return }
  if ($pkg -eq '') { Warn "$label غير موجود — نصّبه يدوياً ثم أعد التشغيل"; return }
  Ensure-Winget
  Say "تثبيت $label …"
  winget install --id $pkg --exact --silent --accept-source-agreements --accept-package-agreements | Out-Null
  # winget يحدّث PATH بعد إعادة تشغيل الجلسة — نضيف المسارات الشائعة لهذه الجلسة
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path','User')
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Ok "$label جاهز" } else { Warn "$label نُصِّب لكنه غير ظاهر في PATH — أعد تشغيل النافذة لاحقاً" }
}

Ensure-Tool node     'OpenJS.NodeJS.LTS' 'Node.js'
Ensure-Tool yt-dlp   'yt-dlp.yt-dlp'     'yt-dlp'
Ensure-Tool ffmpeg   'Gyan.FFmpeg'       'FFmpeg'
Ensure-Tool tailscale 'tailscale.tailscale' 'Tailscale'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js مطلوب. ثبّته من https://nodejs.org ثم أعد المحاولة." }

# ── 2) الاعتماديات والبناء ───────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $root 'node_modules\next'))) {
  Say "تثبيت الاعتماديات (مرة واحدة، ~دقيقة)…"
  if (Test-Path (Join-Path $root 'package-lock.json')) { npm ci --no-audit --no-fund } else { npm install --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { Fail "فشل تثبيت الاعتماديات." }
  Ok "الاعتماديات جاهزة"
}

$buildId = Join-Path $root '.next\BUILD_ID'
if (-not (Test-Path $buildId)) {
  Say "بناء نسخة الإنتاج…"
  npm run build
  if ($LASTEXITCODE -ne 0) { Fail "فشل البناء." }
  Ok "البناء تم"
}

# ── 3) الخادم ───────────────────────────────────────────────────────────────
function Server-Up {
  try {
    $r = Invoke-WebRequest -Uri "$base/api/health" -TimeoutSec 3 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (Server-Up) {
  Ok "الخادم يعمل بالفعل على المنفذ $port"
} else {
  Say "تشغيل الخادم على $base …"
  $env:PORT = "$port"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WorkingDirectory $root -WindowStyle Minimized
  $started = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 700
    if (Server-Up) { $started = $true; break }
  }
  if (-not $started) { Fail "لم يستجب الخادم. شغّل «npm start» يدوياً من $root لرؤية الخطأ." }
  Ok "الخادم يعمل"
}

# ── 4) Tailscale ────────────────────────────────────────────────────────────
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  Warn "Tailscale غير مثبّت — يمكنك استخدام التطبيق محلياً على: $base"
  Start-Process $base
  Read-Host "اضغط Enter للخروج"
  exit 0
}

$tsStatus = & tailscale status --json 2>$null | ConvertFrom-Json
if ($tsStatus.BackendState -ne 'Running') {
  Say "تسجيل الدخول إلى Tailscale (يفتح المتصفح مرة واحدة)…"
  & tailscale up
  Start-Sleep -Seconds 3
  $tsStatus = & tailscale status --json 2>$null | ConvertFrom-Json
}

$fqdn = $tsStatus.Self.DNSName
if (-not $fqdn) {
  Warn "لم أستطع قراءة اسم الجهاز. تأكد من تسجيل الدخول في تطبيق Tailscale ثم أعد التشغيل."
  Start-Process $base
  Read-Host "اضغط Enter للخروج"
  exit 0
}
$fqdn = $fqdn.TrimEnd('.')
Ok "الجهاز في الشبكة: $fqdn"

Say "نشر التطبيق على HTTPS (Tailscale Serve)…"
$serve = & tailscale serve --bg --https=443 $base 2>&1
if ($LASTEXITCODE -ne 0) { $serve = & tailscale serve --bg $port 2>&1 }
Write-Host $serve

$url = "https://$fqdn"
for ($i = 0; $i -lt 20; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "$url/api/health" -TimeoutSec 6 -UseBasicParsing
    if ($r.StatusCode -eq 200) { break }
  } catch { Start-Sleep -Seconds 3 }
}

Write-Host ""
Write-Host "  ──────────────────────────────────────────────" -ForegroundColor DarkMagenta
Write-Host "   الرابط الدائم للتطبيق:" -ForegroundColor White
Write-Host "   $url" -ForegroundColor Cyan
Write-Host "  ──────────────────────────────────────────────" -ForegroundColor DarkMagenta
Write-Host "   من الجوال: ثبّت تطبيق Tailscale وسجّل الدخول بنفس الحساب،" -ForegroundColor Gray
Write-Host "   ثم افتح الرابط ← اضغط «تثبيت التطبيق» (أو مشاركة ← إضافة إلى الشاشة الرئيسية)." -ForegroundColor Gray
Write-Host ""
Write-Host "   محلياً على هذا الجهاز: $base" -ForegroundColor Gray
Write-Host "   لإيقاف المشاركة:  tailscale serve --https=443 off" -ForegroundColor Gray
Write-Host ""

Start-Process $url -ErrorAction SilentlyContinue
Read-Host "  اضغط Enter لإغلاق هذه النافذة (الخادم يبقى يعمل)"
