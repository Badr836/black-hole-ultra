# ---------------------------------------------------------------------------
#  BlackHole Ultra — تشغيل محلي بنقرة واحدة على Windows (بدون أي نفق أو شبكة خارجية)
#
#  يفعل: تثبيت Node.js / yt-dlp / FFmpeg إن لزم ← npm ci ← npm run build ←
#         تشغيل الخادم ← فتح http://localhost:3000
#
#  التثبيت كتطبيق يعمل على localhost أيضاً (المتصفح يعتبره اتصالاً آمناً)،
#  فلا حاجة إلى HTTPS ولا إلى نطاق.
#
#  التشغيل: انقر مرتين على START-LOCAL.bat
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Say([string]$t) { Write-Host ""; Write-Host "  $t" -ForegroundColor Magenta }
function Ok([string]$t)  { Write-Host "  ✓ $t" -ForegroundColor Green }
function Warn([string]$t){ Write-Host "  ! $t" -ForegroundColor Yellow }
function Fail([string]$t){ Write-Host ""; Write-Host "  ✗ $t" -ForegroundColor Red; Write-Host ""; Read-Host "  اضغط Enter للخروج"; exit 1 }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$port = 3000
$base = "http://localhost:$port"

Say "BlackHole Ultra — تشغيل محلي"
Write-Host "  المجلد: $root"

function Ensure-Tool([string]$cmd, [string]$pkg, [string]$label) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Ok "$label موجود"; return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Warn "$label غير موجود، و winget غير متوفّر — ثبّته يدوياً: $label"
    return
  }
  Say "تثبيت $label …"
  winget install --id $pkg --exact --silent --accept-source-agreements --accept-package-agreements | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path','User')
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Ok "$label جاهز" } else { Warn "$label نُصِّب — أعد فتح النافذة إن لم يُعرَف" }
}

Ensure-Tool node   'OpenJS.NodeJS.LTS' 'Node.js'
Ensure-Tool yt-dlp 'yt-dlp.yt-dlp'     'yt-dlp'
Ensure-Tool ffmpeg 'Gyan.FFmpeg'       'FFmpeg'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js مطلوب: https://nodejs.org" }

if (-not (Test-Path (Join-Path $root 'node_modules\next'))) {
  Say "تثبيت الاعتماديات (مرة واحدة)…"
  if (Test-Path (Join-Path $root 'package-lock.json')) { npm ci --no-audit --no-fund } else { npm install --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { Fail "فشل تثبيت الاعتماديات (تحقّق من الاتصال بالإنترنت)." }
  Ok "الاعتماديات جاهزة"
}

if (-not (Test-Path (Join-Path $root '.next\BUILD_ID'))) {
  Say "بناء نسخة الإنتاج…"
  npm run build
  if ($LASTEXITCODE -ne 0) { Fail "فشل البناء." }
  Ok "البناء تم"
}

function Server-Up {
  try {
    $r = Invoke-WebRequest -Uri "$base/api/health" -TimeoutSec 3 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (-not (Server-Up)) {
  Say "تشغيل الخادم…"
  $env:PORT = "$port"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WorkingDirectory $root -WindowStyle Minimized
  $okServer = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 700
    if (Server-Up) { $okServer = $true; break }
  }
  if (-not $okServer) { Fail "لم يستجب الخادم — شغّل «npm start» يدوياً لرؤية الخطأ." }
}
Ok "الخادم يعمل"

Write-Host ""
Write-Host "  ──────────────────────────────────────────────" -ForegroundColor DarkMagenta
Write-Host "   افتح:  $base" -ForegroundColor Cyan
Write-Host "  ──────────────────────────────────────────────" -ForegroundColor DarkMagenta
Write-Host "   تثبيت كتطبيق:" -ForegroundColor Gray
Write-Host "     • Chrome / Edge: زر «تثبيت التطبيق» في شريط العنوان أو من القائمة ⋮" -ForegroundColor Gray
Write-Host "     • من الجوال على نفس الواي فاي: افتح http://<IP-جهازك>:$port" -ForegroundColor Gray
Write-Host "       (يعمل لكن بدون تثبيت PWA لأن الاتصال HTTP — للتثبيت استخدم Tailscale)" -ForegroundColor Gray
Write-Host ""

Start-Process $base -ErrorAction SilentlyContinue
Read-Host "  اضغط Enter لإغلاق النافذة (الخادم يبقى يعمل في الخلفية)"
