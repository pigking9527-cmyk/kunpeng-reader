param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$fastExe = Join-Path $repo "target\fast\ebook-reader-tauri.exe"
$fastOrt = Join-Path $repo "target\fast\onnxruntime.dll"
$productName = -join @([char]0x9cb2, [char]0x9e4f, [char]0x9605, [char]0x8bfb, [char]0x5668)
$desktopExe = Join-Path ([Environment]::GetFolderPath("Desktop")) ($productName + ".exe")
$desktopOrt = Join-Path ([Environment]::GetFolderPath("Desktop")) "onnxruntime.dll"

function Stop-ReaderProcesses {
  # 只关闭明确指向桌面交付版的进程，绝不按同名进程猜测。
  $targetPath = [IO.Path]::GetFullPath($desktopExe)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $targetPath, [StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Copy-DesktopArtifact([string]$Source, [string]$Destination) {
  try { Copy-Item -LiteralPath $Source -Destination $Destination -Force }
  catch {
    Start-Sleep -Seconds 2
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
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
  if (-not (Test-Path -LiteralPath $fastOrt)) {
    throw "ONNX Runtime DLL not found: $fastOrt"
  }

  Stop-ReaderProcesses
  Copy-DesktopArtifact $fastExe $desktopExe
  Copy-DesktopArtifact $fastOrt $desktopOrt
  Get-Item -LiteralPath $desktopExe, $desktopOrt | Select-Object FullName, Length, LastWriteTime
  Write-Host "Fast GUI executable and ONNX Runtime copied to desktop. Use scripts/build-release.ps1 for official releases."
} finally {
  Pop-Location
}
