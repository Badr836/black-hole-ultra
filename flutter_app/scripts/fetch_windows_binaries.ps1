# Downloads yt-dlp.exe and a static ffmpeg.exe into ./bin (next to the app at build time).
$ErrorActionPreference = "Stop"
$bin = Join-Path $PSScriptRoot "..\bin"
New-Item -ItemType Directory -Force $bin | Out-Null

Write-Host "→ yt-dlp.exe"
Invoke-WebRequest "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile (Join-Path $bin "yt-dlp.exe")

Write-Host "→ ffmpeg (yt-dlp custom build, recommended)"
$zip = Join-Path $env:TEMP "ffmpeg-bh.zip"
Invoke-WebRequest "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip" -OutFile $zip
$tmp = Join-Path $env:TEMP "ffmpeg-bh"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip $tmp
Get-ChildItem $tmp -Recurse -Include ffmpeg.exe, ffprobe.exe | ForEach-Object { Copy-Item $_.FullName $bin -Force }
Remove-Item $zip, $tmp -Recurse -Force

Write-Host "✓ Binaries ready in $bin"
Get-ChildItem $bin
