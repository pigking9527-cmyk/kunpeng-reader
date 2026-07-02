param(
  [switch]$Release
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  Write-Host '== cargo check =='
  cargo check

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js not found: cannot run JavaScript syntax checks.'
  }

  Write-Host '== node --check =='
  $jsFiles = @(
    'ui/app.js',
    'ui/reader.js',
    'ui/pdfview.js'
  )
  foreach ($file in $jsFiles) {
    if (Test-Path -LiteralPath $file) {
      node --check $file
    }
  }

  Write-Host '== UTF-8 strict check =='
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $extensions = @('.rs', '.js', '.html', '.css', '.json', '.toml', '.md', '.ps1')
  $skipParts = @('\.git\', '\target\', '\ui\pdfjs\')
  $bad = New-Object System.Collections.Generic.List[string]
  Get-ChildItem -LiteralPath $repo -Recurse -File | Where-Object {
    $path = $_.FullName
    ($extensions -contains $_.Extension.ToLowerInvariant()) -and
    -not ($skipParts | Where-Object { $path -like "*$_*" })
  } | ForEach-Object {
    try {
      [void]$utf8.GetString([System.IO.File]::ReadAllBytes($_.FullName))
    } catch {
      $bad.Add($_.FullName)
    }
  }
  if ($bad.Count) {
    $bad | ForEach-Object { Write-Error "Invalid UTF-8: $_" }
    throw "$($bad.Count) file(s) failed UTF-8 strict check."
  }

  Write-Host '== version consistency =='
  $cargo = [System.IO.File]::ReadAllText((Join-Path $repo 'Cargo.toml'), [System.Text.Encoding]::UTF8)
  $tauriText = [System.IO.File]::ReadAllText((Join-Path $repo 'tauri.conf.json'), [System.Text.Encoding]::UTF8)
  $tauri = $tauriText | ConvertFrom-Json
  $cargoVersion = [regex]::Match($cargo, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
  $tauriVersion = [string]$tauri.version
  if (-not $cargoVersion) { throw 'Cargo.toml version not found.' }
  if ($cargoVersion -ne $tauriVersion) {
    throw "Version mismatch: Cargo.toml=$cargoVersion, tauri.conf.json=$tauriVersion"
  }
  Write-Host "version: $cargoVersion"

  Write-Host '== icon resources =='
  $icons = @($tauri.bundle.icon)
  if (-not $icons.Count) { throw 'tauri.conf.json bundle.icon is empty.' }
  foreach ($icon in $icons) {
    if (-not (Test-Path -LiteralPath $icon)) { throw "Icon missing: $icon" }
    $item = Get-Item -LiteralPath $icon
    if ($item.Length -lt 1024) { throw "Icon too small or invalid: $icon ($($item.Length) bytes)" }
  }
  if (-not (Test-Path -LiteralPath 'icons/icon.ico')) { throw 'icons/icon.ico missing.' }
  if (-not (Test-Path -LiteralPath 'icons/icon.png')) { throw 'icons/icon.png missing.' }

  Write-Host '== CSS sanity =='
  $cssFiles = Get-ChildItem -LiteralPath 'ui' -Filter '*.css' -File -Recurse
  foreach ($css in $cssFiles) {
    $text = [System.IO.File]::ReadAllText($css.FullName, [System.Text.Encoding]::UTF8)
    if ($text -match '`r`n|`n|`r') { throw "Literal backtick newline marker found in CSS: $($css.FullName)" }
    $open = ([regex]::Matches($text, '\{')).Count
    $close = ([regex]::Matches($text, '\}')).Count
    if ($open -ne $close) { throw "CSS brace mismatch in $($css.FullName): {$open} vs {$close}" }
    if ($text -match '<<<<<<<|=======|>>>>>>>') { throw "Merge conflict marker found in CSS: $($css.FullName)" }
  }

  if ($Release) {
    Write-Host '== release artifacts =='
    $releaseExe = Join-Path $repo 'target\release\ebook-reader-tauri.exe'
    $productExe = [string]$tauri.productName + '.exe'
    $repoExe = Join-Path $repo $productExe
    $desktopExe = Join-Path ([Environment]::GetFolderPath('Desktop')) $productExe
    foreach ($file in @($releaseExe, $repoExe, $desktopExe)) {
      if (-not (Test-Path -LiteralPath $file)) { throw "Release artifact missing: $file" }
      $item = Get-Item -LiteralPath $file
      if ($item.Length -lt 10MB) { throw "Release artifact looks too small: $file ($($item.Length) bytes)" }
    }
    $installer = Get-ChildItem -LiteralPath (Join-Path $repo 'target\release\bundle') -Recurse -File -Include '*.exe','*.msi' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if (-not $installer) { throw 'No installer found under target\release\bundle.' }
    Write-Host "installer: $($installer.FullName)"
  }

  Write-Host 'All checks passed.'
} finally {
  Pop-Location
}
