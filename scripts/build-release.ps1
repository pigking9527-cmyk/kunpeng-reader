param(
  [switch]$SkipBuild,
  [switch]$SkipIconCacheRefresh
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$release = Join-Path $repo "target\release\ebook-reader-tauri.exe"
$repoExe = Join-Path $repo "鲲鹏阅读器.exe"
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopExe = Join-Path $desktop "鲲鹏阅读器.exe"

function Stop-ReaderProcesses {
  $targets = @($release, $repoExe, $desktopExe)
  Get-Process | ForEach-Object {
    try { $path = $_.Path } catch { $path = $null }
    if (($path -and ($targets -contains $path)) -or $_.ProcessName -in @("ebook-reader-tauri", "鲲鹏阅读器")) {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  }
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
    cargo build --release
  }
  if (-not (Test-Path -LiteralPath $release)) { throw "release exe 不存在：$release" }
  Assert-NewIconEmbedded
  Stop-ReaderProcesses
  Copy-Item -LiteralPath $release -Destination $repoExe -Force
  Copy-Item -LiteralPath $release -Destination $desktopExe -Force
  if (-not $SkipIconCacheRefresh) { Clear-ExplorerIconCache }
  Get-Item -LiteralPath $repoExe, $desktopExe | Select-Object FullName, Length, LastWriteTime
} finally {
  Pop-Location
}

