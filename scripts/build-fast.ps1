param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$fastExe = Join-Path $repo "target\fast\ebook-reader-tauri.exe"
$productName = -join @([char]0x9cb2, [char]0x9e4f, [char]0x9605, [char]0x8bfb, [char]0x5668)
$desktopExe = Join-Path ([Environment]::GetFolderPath("Desktop")) ($productName + ".exe")

function Stop-ReaderProcesses {
  $targets = @($fastExe, $desktopExe)
  Get-Process | ForEach-Object {
    try { $path = $_.Path } catch { $path = $null }
    if (($path -and ($targets -contains $path)) -or $_.ProcessName -eq "ebook-reader-tauri") {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

Push-Location $repo
try {
  if ($Check) {
    Write-Host "== cargo check =="
    cargo check

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      throw "Node.js not found: cannot run JavaScript syntax checks."
    }

    Write-Host "== node --check =="
    $jsFiles = Get-ChildItem -LiteralPath "ui" -Filter "*.js" -File -Recurse |
      Where-Object { $_.FullName -notlike "*\ui\pdfjs\*" } |
      Sort-Object FullName
    foreach ($file in $jsFiles) {
      node --check $file.FullName
    }
  }

  Write-Host "== cargo build --profile fast =="
  cargo build --profile fast

  if (-not (Test-Path -LiteralPath $fastExe)) {
    throw "Fast exe not found: $fastExe"
  }

  Stop-ReaderProcesses
  Copy-Item -LiteralPath $fastExe -Destination $desktopExe -Force
  Get-Item -LiteralPath $desktopExe | Select-Object FullName, Length, LastWriteTime
  Write-Host "Fast GUI exe copied to desktop. Use scripts/build-release.ps1 for official releases."
} finally {
  Pop-Location
}
