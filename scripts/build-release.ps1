param(
  [switch]$SkipBuild,
  [switch]$SkipIconCacheRefresh
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$release = Join-Path $repo "target\release\ebook-reader-tauri.exe"
$releaseWorker = Join-Path $repo "target\release\kunpeng-intelligence-worker.exe"
$releaseHost = Join-Path $repo "target\release\kunpeng-intelligence-host.exe"
$releaseRuntimeDir = Split-Path -Parent $release
$repoExe = Join-Path $repo "鲲鹏阅读器.exe"
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopShortcut = Join-Path $desktop "鲲鹏阅读器.lnk"
$legacyDesktopExe = Join-Path $desktop "鲲鹏阅读器.exe"

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
  # `ort` discovers CUDA Provider DLLs beside the executable. The desktop
  # shortcut points at `$repoExe`, so it must receive the matching companions
  # from this exact build, rather than only the EXE.
  $sourceFiles = @(Get-ChildItem -LiteralPath $SourceDirectory -Filter "onnxruntime*.dll" -File -ErrorAction Stop)
  if ($sourceFiles.Count -eq 0) {
    throw "ONNX Runtime companion DLLs are missing from build directory: $SourceDirectory"
  }
  foreach ($file in $sourceFiles) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $DestinationDirectory $file.Name) -Force
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
  $shortcut.Description = "鲲鹏阅读器"
  $shortcut.Save()
}

function Assert-NewIconEmbedded {
  Add-Type -AssemblyName System.Drawing
  $tmp = Join-Path $env:TEMP "kunpeng-reader-extracted-icon.png"
  $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($release)
  if ($null -eq $ico) { throw "无法从 release exe 抽取图标" }
  $bmp = $ico.ToBitmap()
  $corner = $bmp.GetPixel(0, 0)
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $ico.Dispose()
  Write-Host "Extracted icon: $tmp"
  # 旧图标的左上角是实色青绿；新图标抽取后左上角接近黑/透明合成，不应是青绿块。
  if ($corner.G -gt 90 -and $corner.R -lt 50 -and $corner.B -gt 70) {
    throw "release exe 内部仍像旧图标，停止复制。"
  }
}

function Clear-ExplorerIconCache {
  Write-Host "Refreshing Windows icon cache..."
  $local = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
  $explorerDir = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Explorer"))
  $cacheFiles = New-Object System.Collections.Generic.List[string]
  $mainCache = Join-Path $env:LOCALAPPDATA "IconCache.db"
  if (Test-Path -LiteralPath $mainCache) { $cacheFiles.Add([IO.Path]::GetFullPath($mainCache)) }
  if (Test-Path -LiteralPath $explorerDir) {
    Get-ChildItem -LiteralPath $explorerDir -Filter "iconcache_*.db" -File -ErrorAction SilentlyContinue | ForEach-Object {
      $cacheFiles.Add([IO.Path]::GetFullPath($_.FullName))
    }
  }

  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700
  foreach ($file in $cacheFiles) {
    $full = [IO.Path]::GetFullPath($file)
    $inLocal = $full.StartsWith($local, [StringComparison]::OrdinalIgnoreCase)
    $isIconCache = ([IO.Path]::GetFileName($full) -eq "IconCache.db") -or ([IO.Path]::GetFileName($full) -like "iconcache_*.db")
    if ($inLocal -and $isIconCache) {
      Remove-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    }
  }
  & ie4uinit.exe -ClearIconCache | Out-Null
  Start-Process explorer.exe
}

Push-Location $repo
try {
  if (-not $SkipBuild) {
    cargo build --release --bins
  }
  foreach ($required in @($release, $releaseWorker, $releaseHost)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "release executable 不存在：$required" }
  }
  Assert-NewIconEmbedded
  Stop-ReaderProcesses
  Copy-Item -LiteralPath $release -Destination $repoExe -Force
  Copy-Item -LiteralPath $releaseWorker -Destination (Join-Path $repo "kunpeng-intelligence-worker.exe") -Force
  Sync-OnnxRuntimeCompanions $releaseRuntimeDir $repo
  Write-DesktopShortcut
  Remove-Item -LiteralPath $legacyDesktopExe -Force -ErrorAction SilentlyContinue
  if (-not $SkipIconCacheRefresh) { Clear-ExplorerIconCache }
  $delivered = @($repoExe, $desktopShortcut) + (Get-ChildItem -LiteralPath $repo -Filter "onnxruntime*.dll" -File | ForEach-Object FullName)
  Get-Item -LiteralPath $delivered | Select-Object FullName, Length, LastWriteTime
} finally {
  Pop-Location
}
