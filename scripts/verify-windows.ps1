<#
  BlackHole Ultra — Windows verification script.

  There is no Windows machine in the development environment (Linux only), so the
  Windows path is prepared and unit-tested but never claimed as "verified".
  Running this script on a real Windows box produces the missing evidence.

  Usage (PowerShell 5.1+ or 7+), from the repository root:

      powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1

  It checks the toolchain, runs the same gates as Linux, starts the server on
  port 3000, runs the offline integration suite against it, then stops it.
  Everything it learns is printed and also written to docs\windows-report.txt.
#>

$ErrorActionPreference = "Continue"
$report = New-Object System.Collections.Generic.List[string]
function Say($text) { Write-Host $text; $report.Add($text) | Out-Null }
function Check($name, $ok, $detail) {
  $mark = if ($ok) { "PASS" } else { "FAIL" }
  Say ("[{0}] {1}{2}" -f $mark, $name, $(if ($detail) { " — $detail" } else { "" }))
  return $ok
}

Say "=== BlackHole Ultra — Windows verification ==="
Say ("Date:       {0}" -f (Get-Date -Format "u"))
Say ("OS:         {0}" -f [System.Environment]::OSVersion.VersionString)
Say ("PowerShell: {0}" -f $PSVersionTable.PSVersion)
Say ""

# ---------------------------------------------------------------- toolchain ---
$nodeVersion = (node --version) 2>$null
$nodeOk = $false
if ($nodeVersion -match "^v(\d+)\.") { $nodeOk = [int]$Matches[1] -ge 22 }
Check "Node.js >= 22" $nodeOk $nodeVersion

$tools = @(
  @{ name = "yt-dlp";       args = @("--version") },
  @{ name = "ffmpeg";       args = @("-version") },
  @{ name = "ffprobe";      args = @("-version") },
  @{ name = "gallery-dl";   args = @("--version") },
  @{ name = "aria2c";       args = @("--version") },
  @{ name = "N_m3u8DL-RE";  args = @("--version") }
)
foreach ($tool in $tools) {
  $cmd = Get-Command $tool.name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $local = Join-Path $PWD ("bin\{0}.exe" -f $tool.name)
    if (Test-Path $local) { $cmd = $local }
  }
  if ($cmd) {
    $ver = (& $cmd @($tool.args) 2>&1 | Select-Object -First 1)
    Check $tool.name $true ("{0} · {1}" -f $cmd, $ver)
  } else {
    # aria2c and N_m3u8DL-RE are optional; the rest are required.
    $optional = $tool.name -in @("aria2c", "N_m3u8DL-RE")
    Check $tool.name $optional "not found (optional)"
  }
}

# Windows-specific path handling: the tool paths must survive untouched.
Say ""
Say "--- Windows path handling ---"
$ffmpegLocal = Join-Path $PWD "bin\ffmpeg.exe"
Say ("bin path resolves to: {0}" -f $ffmpegLocal)

# ------------------------------------------------------------------- gates ---
Say ""
Say "--- npm gates ---"
$tests = (npm test 2>&1 | Out-String)
Say ($tests -split "`n" | Where-Object { $_ -match "^# (pass|fail)" } | Out-String)
$typecheck = (npx tsc --noEmit 2>&1 | Out-String)
Check "tsc --noEmit" ($LASTEXITCODE -eq 0) ($typecheck -split "`n" | Select-Object -First 1)
$lint = (npm run lint 2>&1 | Out-String)
Check "eslint" ($LASTEXITCODE -eq 0) ""
$build = (npm run build 2>&1 | Out-String)
Check "next build" ($LASTEXITCODE -eq 0) (($build -split "`n" | Select-Object -Last 2) -join " ")

# ---------------------------------------------------------------- e2e ------
Say ""
Say "--- server + offline integration suite ---"
$log = Join-Path $env:TEMP "blackhole-windows.log"
$env:HOSTNAME = "127.0.0.1"
$env:PORT = "3000"
$server = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start > `"$log`" 2>&1" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 12
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 10
  Check "GET /api/health" ($health.ok -eq $true) ("schema v{0}" -f $health.db.schemaVersion)
  $integration = (node --import tsx tests/e2e/integration.ts 2>&1 | Out-String)
  Say $integration
  $summary = ($integration -split "`n" | Where-Object { $_ -match "فحوص ناجحة" } | Select-Object -Last 1)
  Check "offline integration suite" ($integration -match "(\d+)/\1 ") $summary
} catch {
  Check "server reachable" $false $_.Exception.Message
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*node.exe" } | Stop-Process -Force -ErrorAction SilentlyContinue
}

Say ""
Say "Send docs\windows-report.txt back so the Windows gap can be closed with evidence."
$out = Join-Path $PWD "docs\windows-report.txt"
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
$report | Set-Content -Path $out -Encoding UTF8
Write-Host ("Report written to {0}" -f $out)
