[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 38421,
  [switch]$Build
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $projectRoot 'target\debug\kunpeng-intelligence-host.exe'
$address = "http://127.0.0.1:$Port/"
$inputs = @(
  (Join-Path $projectRoot 'src\bin\kunpeng-intelligence-host.rs'),
  (Join-Path $projectRoot 'src\intelligence_host\dashboard.rs'),
  (Join-Path $projectRoot 'src\intelligence_host\mod.rs'),
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
    cargo build --bin kunpeng-intelligence-host
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
