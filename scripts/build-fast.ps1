param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$fastExe = Join-Path $repo "target\fast\ebook-reader-tauri.exe"
$fastOrt = Join-Path $repo "target\fast\onnxruntime.dll"
$productName = -join @([char]0x9cb2, [char]0x9e4f, [char]0x9605, [char]0x8bfb, [char]0x5668)
$repoExe = Join-Path $repo ($productName + ".exe")
$repoOrt = Join-Path $repo "onnxruntime.dll"
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopShortcut = Join-Path $desktop ($productName + ".lnk")
$legacyDesktopExe = Join-Path $desktop ($productName + ".exe")
$legacyDesktopOrt = Join-Path $desktop "onnxruntime.dll"

function Stop-ReaderProcesses {
  # 只关闭本脚本明确交付路径中的进程，绝不按同名进程猜测。
  $targets = @($repoExe, $legacyDesktopExe) | ForEach-Object { [IO.Path]::GetFullPath($_) }
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and ($targets -contains [IO.Path]::GetFullPath($_.ExecutablePath))
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

function Write-DesktopShortcut {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($desktopShortcut)
  $shortcut.TargetPath = $repoExe
  $shortcut.WorkingDirectory = $repo
  $shortcut.IconLocation = "$repoExe,0"
  $shortcut.Description = $productName
  $shortcut.Save()
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
  Copy-DesktopArtifact $fastExe $repoExe
  Copy-DesktopArtifact $fastOrt $repoOrt
  Write-DesktopShortcut
  Remove-Item -LiteralPath $legacyDesktopExe, $legacyDesktopOrt -Force -ErrorAction SilentlyContinue
  Get-Item -LiteralPath $repoExe, $repoOrt, $desktopShortcut | Select-Object FullName, Length, LastWriteTime
  Write-Host "Fast GUI executable and ONNX Runtime stay in the repository; desktop only receives a shortcut. Use scripts/build-release.ps1 for official releases."
} finally {
  Pop-Location
}
