param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$fastExe = Join-Path $repo "target\fast\ebook-reader-tauri.exe"
$fastWorker = Join-Path $repo "target\fast\kunpeng-intelligence-worker.exe"
$fastRuntimeDir = Split-Path -Parent $fastExe
$productName = -join @([char]0x9cb2, [char]0x9e4f, [char]0x9605, [char]0x8bfb, [char]0x5668)
$repoExe = Join-Path $repo ($productName + ".exe")
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopShortcut = Join-Path $desktop ($productName + ".lnk")
$legacyDesktopExe = Join-Path $desktop ($productName + ".exe")

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

function Sync-OnnxRuntimeCompanions([string]$SourceDirectory, [string]$DestinationDirectory) {
  # `ort` loads its CUDA Provider adjacent to the process executable. Copying
  # only the EXE makes GPU probing silently fail even though the freshly built
  # target directory is complete. Keep the approved ONNX Runtime DLL family
  # next to the shortcut target; this is not a CUDA/cuDNN redistribution.
  $sourceFiles = @(Get-ChildItem -LiteralPath $SourceDirectory -Filter "onnxruntime*.dll" -File -ErrorAction Stop)
  if ($sourceFiles.Count -eq 0) {
    throw "ONNX Runtime companion DLLs are missing from build directory: $SourceDirectory"
  }
  foreach ($file in $sourceFiles) {
    Copy-DesktopArtifact $file.FullName (Join-Path $DestinationDirectory $file.Name)
  }
  $sourceNames = @($sourceFiles.Name)
  Get-ChildItem -LiteralPath $DestinationDirectory -Filter "onnxruntime*.dll" -File -ErrorAction SilentlyContinue |
    Where-Object { $sourceNames -notcontains $_.Name } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

  foreach ($required in "onnxruntime_providers_cuda.dll", "onnxruntime_providers_shared.dll") {
    if (-not (Test-Path -LiteralPath (Join-Path $DestinationDirectory $required))) {
      throw "Desktop runtime companion is missing after copy: $required"
    }
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
      if ($file.Name -eq "pdfview.js") {
        Get-Content -LiteralPath $file.FullName -Raw | node --input-type=module --check
      } else {
        node --check $file.FullName
      }
      if ($LASTEXITCODE -ne 0) {
        throw "node --check failed for $($file.FullName)"
      }
    }
  }

  Write-Host "== cargo build --profile fast (reader + intelligence worker) =="
  cargo build --profile fast --bins

  foreach ($required in @($fastExe, $fastWorker)) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Fast executable not found: $required"
    }
  }

  Stop-ReaderProcesses
  Copy-DesktopArtifact $fastExe $repoExe
  Copy-DesktopArtifact $fastWorker (Join-Path $repo "kunpeng-intelligence-worker.exe")
  Sync-OnnxRuntimeCompanions $fastRuntimeDir $repo
  Write-DesktopShortcut
  Remove-Item -LiteralPath $legacyDesktopExe -Force -ErrorAction SilentlyContinue
  $delivered = @($repoExe, $desktopShortcut) + (Get-ChildItem -LiteralPath $repo -Filter "onnxruntime*.dll" -File | ForEach-Object FullName)
  Get-Item -LiteralPath $delivered | Select-Object FullName, Length, LastWriteTime
  Write-Host "Fast GUI executable stays in the repository; desktop only receives a shortcut. Use scripts/build-release.ps1 for official releases."
} finally {
  Pop-Location
}
