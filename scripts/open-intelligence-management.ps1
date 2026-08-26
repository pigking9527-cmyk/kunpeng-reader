[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 38421,
  [switch]$Build
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
# The continuous host loop intentionally uses the ordinary debug binary and
# may run for hours.  Building the dashboard into the same path would require
# stopping that worker just to refresh its operator UI.  Keep this small,
# loopback-only observer in a separate ignored target directory so opening the
# management page never interrupts collection or flashes a console window.
$dashboardTarget = Join-Path $projectRoot 'target\intelligence-dashboard'
$binary = Join-Path $dashboardTarget 'debug\kunpeng-intelligence-host.exe'
$address = "http://127.0.0.1:$Port/"
$inputs = @(
  (Join-Path $projectRoot 'src\bin\kunpeng-intelligence-host.rs'),
  (Join-Path $projectRoot 'src\intelligence_host\dashboard.rs'),
  (Join-Path $projectRoot 'src\intelligence_host\audit.rs'),
  (Join-Path $projectRoot 'src\intelligence_host\mod.rs'),
  (Join-Path $projectRoot 'src\bin\kunpeng-intelligence-worker.rs'),
  (Join-Path $projectRoot 'src\intelligence_worker\mod.rs'),
  (Join-Path $projectRoot 'src\intelligence_worker\publication.rs'),
  (Join-Path $projectRoot 'src\intelligence_worker_lifecycle.rs'),
  (Join-Path $projectRoot 'src\secret_store.rs'),
  (Join-Path $projectRoot 'apps\intelligence-host\dashboard.html'),
  (Join-Path $projectRoot 'apps\intelligence-host\dashboard.css'),
  (Join-Path $projectRoot 'apps\intelligence-host\dashboard.js')
)
$binaryIsCurrent = (Test-Path -LiteralPath $binary -PathType Leaf) -and -not ($inputs | Where-Object {
  (Test-Path -LiteralPath $_ -PathType Leaf) -and ((Get-Item -LiteralPath $_).LastWriteTimeUtc -gt (Get-Item -LiteralPath $binary).LastWriteTimeUtc)
})

if ($Build -or -not $binaryIsCurrent) {
  Push-Location $projectRoot
  try {
    $previousTarget = $env:CARGO_TARGET_DIR
    $env:CARGO_TARGET_DIR = $dashboardTarget
    try {
      # The dashboard may start a one-shot or continuous local processing
      # round.  Build the sibling worker in the same isolated target so its
      # status and actions always describe the version shown by this page.
      cargo build --bin kunpeng-intelligence-host --bin kunpeng-intelligence-worker
    } finally {
      $env:CARGO_TARGET_DIR = $previousTarget
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
  throw 'The local intelligence management service binary was not built.'
}

$alreadyListening = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $Port -ErrorAction SilentlyContinue
if (-not $alreadyListening) {
  Start-Process -FilePath $binary -ArgumentList @('--dashboard', $Port) -WorkingDirectory $projectRoot -WindowStyle Hidden
  $ready = $false
  foreach ($attempt in 1..30) {
    Start-Sleep -Milliseconds 200
    try {
      $client = [System.Net.Sockets.TcpClient]::new()
      $client.Connect('127.0.0.1', $Port)
      $client.Dispose()
      $ready = $true
      break
    } catch {}
  }
  if (-not $ready) {
    throw 'The local intelligence management service did not start.'
  }
}

Start-Process $address
