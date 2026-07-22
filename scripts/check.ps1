param(
  [switch]$Release
)

$ErrorActionPreference = 'Stop'

function Invoke-NativeCheck {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command
  )

  & $Command
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "$Name failed with exit code $exitCode."
  }
}
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  Write-Host '== cargo fmt --check =='
  Invoke-NativeCheck 'cargo fmt --check' { cargo fmt -- --check }

  Write-Host '== cargo clippy =='
  Invoke-NativeCheck 'cargo clippy' { cargo clippy --all-targets -- -D warnings }

  Write-Host '== cargo check =='
  Invoke-NativeCheck 'cargo check' { cargo check }

  Write-Host '== cargo test =='
  Invoke-NativeCheck 'cargo test' { cargo test }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js not found: cannot run JavaScript syntax checks.'
  }

  Write-Host '== node --check =='
  $jsFiles = Get-ChildItem -LiteralPath 'ui' -Filter '*.js' -File -Recurse |
    Where-Object { $_.FullName -notlike "*\ui\pdfjs\*" } |
    Sort-Object FullName
  foreach ($file in $jsFiles) {
    Invoke-NativeCheck "node --check $($file.FullName)" { node --check $file.FullName }
  }

  Write-Host '== frontend behavior tests =='
  Invoke-NativeCheck 'frontend behavior tests' { node --test 'ui/tests/*.test.cjs' }

  if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python not found: cannot run sync server tests.'
  }
  Write-Host '== sync server tests =='
  $previousNoBytecode = $env:PYTHONDONTWRITEBYTECODE
  $env:PYTHONDONTWRITEBYTECODE = '1'
  Push-Location (Join-Path $repo 'server\reader-sync-api')
  try {
    Invoke-NativeCheck 'sync server tests' { python -m unittest -v test_app.py }
  } finally {
    Pop-Location
    $env:PYTHONDONTWRITEBYTECODE = $previousNoBytecode
  }

  if (Get-Command cargo-audit -ErrorAction SilentlyContinue) {
    Write-Host '== cargo audit =='
    Invoke-NativeCheck 'cargo audit' { cargo audit --no-yanked }
  } else {
    Write-Warning 'cargo-audit is not installed; CI installs it and enforces the audit gate.'
  }

  Write-Host '== frontend module boundaries =='
  $mainSyncJs = Join-Path $repo 'ui\sync-ui.js'
  $mainStatsJs = Join-Path $repo 'ui\stats-ui.js'
  $mainShelfJs = Join-Path $repo 'ui\shelf-ui.js'
  $semanticStatusCacheJs = Join-Path $repo 'ui\semantic-status-cache.js'
  $semanticUiJs = Join-Path $repo 'ui\semantic-ui.js'
  if (-not (Test-Path -LiteralPath $mainSyncJs)) { throw 'ui/sync-ui.js missing.' }
  if (-not (Test-Path -LiteralPath $mainStatsJs)) { throw 'ui/stats-ui.js missing.' }
  if (-not (Test-Path -LiteralPath $mainShelfJs)) { throw 'ui/shelf-ui.js missing.' }
  if (-not (Test-Path -LiteralPath $semanticStatusCacheJs)) { throw 'ui/semantic-status-cache.js missing.' }
  if (-not (Test-Path -LiteralPath $semanticUiJs)) { throw 'ui/semantic-ui.js missing.' }
  $indexHtmlForScripts = [System.IO.File]::ReadAllText((Join-Path $repo 'ui\index.html'), [System.Text.Encoding]::UTF8)
  $appJsPos = $indexHtmlForScripts.IndexOf('app.js')
  $syncUiPos = $indexHtmlForScripts.IndexOf('sync-ui.js')
  $statsUiPos = $indexHtmlForScripts.IndexOf('stats-ui.js')
  $shelfUiPos = $indexHtmlForScripts.IndexOf('shelf-ui.js')
  $semanticStatusCachePos = $indexHtmlForScripts.IndexOf('semantic-status-cache.js')
  $semanticUiPos = $indexHtmlForScripts.IndexOf('semantic-ui.js')
  if ($semanticStatusCachePos -lt 0 -or $semanticUiPos -lt $semanticStatusCachePos -or $semanticUiPos -gt $appJsPos) {
    throw 'semantic-status-cache.js and semantic-ui.js must be loaded in dependency order before app.js.'
  }
  if ($appJsPos -lt 0 -or $syncUiPos -lt 0 -or $statsUiPos -lt 0 -or $shelfUiPos -lt 0 -or $syncUiPos -gt $appJsPos -or $statsUiPos -gt $appJsPos -or $shelfUiPos -gt $appJsPos) {
    throw 'sync-ui.js, stats-ui.js and shelf-ui.js must be loaded before app.js so app.js can initialize their explicit APIs.'
  }
  foreach ($requiredIndexId in @('shelf-search-modal', 'shelf-search-frame', 'stats-chart-metric')) {
    if ($indexHtmlForScripts -notmatch [regex]::Escape($requiredIndexId)) {
      throw "ui/index.html missing required integrated UI element: $requiredIndexId"
    }
  }

  $readerSearchJs = Join-Path $repo 'ui\reader-search-ui.js'
  $readerSettingsJs = Join-Path $repo 'ui\reader-settings-ui.js'
  $readerNotesJs = Join-Path $repo 'ui\reader-notes-ui.js'
  $readerCrossJs = Join-Path $repo 'ui\reader-cross-search-ui.js'
  if (-not (Test-Path -LiteralPath $readerSearchJs)) { throw 'ui/reader-search-ui.js missing.' }
  if (-not (Test-Path -LiteralPath $readerSettingsJs)) { throw 'ui/reader-settings-ui.js missing.' }
  if (-not (Test-Path -LiteralPath $readerNotesJs)) { throw 'ui/reader-notes-ui.js missing.' }
  if (-not (Test-Path -LiteralPath $readerCrossJs)) { throw 'ui/reader-cross-search-ui.js missing.' }
  $readerHtmlForScripts = [System.IO.File]::ReadAllText((Join-Path $repo 'ui\reader.html'), [System.Text.Encoding]::UTF8)
  $readerSearchPos = $readerHtmlForScripts.IndexOf('reader-search-ui.js')
  $readerSettingsPos = $readerHtmlForScripts.IndexOf('reader-settings-ui.js')
  $readerNotesPos = $readerHtmlForScripts.IndexOf('reader-notes-ui.js')
  $readerCrossPos = $readerHtmlForScripts.IndexOf('reader-cross-search-ui.js')
  $readerJsPos = $readerHtmlForScripts.IndexOf('reader.js')
  $vocabUiPos = $readerHtmlForScripts.IndexOf('vocab-ui.js')
  if ($readerSearchPos -lt 0 -or $readerJsPos -lt 0 -or $readerSearchPos -gt $readerJsPos) {
    throw 'reader-search-ui.js must be loaded before reader.js because it provides sendToPage and search UI globals.'
  }
  if ($readerSettingsPos -lt 0 -or $readerJsPos -lt 0 -or $readerSettingsPos -gt $readerJsPos) {
    throw 'reader-settings-ui.js must be loaded before reader.js because it provides reader settings globals.'
  }
  if ($readerNotesPos -lt 0 -or $readerJsPos -lt 0 -or $readerNotesPos -lt $readerJsPos) {
    throw 'reader-notes-ui.js must be loaded after reader.js because it binds reader DOM globals.'
  }
  if ($vocabUiPos -ge 0 -and $readerNotesPos -gt $vocabUiPos) {
    throw 'reader-notes-ui.js must be loaded before vocab-ui.js because vocab UI calls setToc.'
  }
  if ($readerCrossPos -lt 0 -or $readerJsPos -lt 0 -or $readerCrossPos -lt $readerJsPos) {
    throw 'reader-cross-search-ui.js must be loaded after reader.js because it uses reader window globals and invokes open_book_at.'
  }
  $readerPageRs = [System.IO.File]::ReadAllText((Join-Path $repo 'src\reader_page.rs'), [System.Text.Encoding]::UTF8)
  $readerModuleNames = @('reader-page-style.html', 'reader-page-layout.js', 'reader-page-pagination.js', 'reader-page-measurement.js', 'reader-page-annotations.js', 'reader-page-runtime.js')
  foreach ($readerModuleName in $readerModuleNames) {
    $readerModuleNeedle = 'include_str!("../ui/' + $readerModuleName + '")'
    if ($readerPageRs -notmatch [regex]::Escape($readerModuleNeedle)) {
      throw "reader_page.rs missing injected reader module: $readerModuleName"
    }
  }
  $readerInjectedHead = ($readerModuleNames | ForEach-Object {
    [System.IO.File]::ReadAllText((Join-Path $repo "ui\$_"), [System.Text.Encoding]::UTF8)
  }) -join ''
  foreach ($requiredReaderHook in @('showTranslateResult', 'translateText', 'semanticSearch', 'hl-settings-pop', 'highlightMenuActionsV1', 'highlightMenuDisplayModeV1', 'highlightMenuSizeV1', 'showFootnote')) {
    if ($readerInjectedHead -notmatch [regex]::Escape($requiredReaderHook)) {
      throw "reader injected modules missing required hook: $requiredReaderHook"
    }
  }
  $readerJsText = [System.IO.File]::ReadAllText((Join-Path $repo 'ui\reader.js'), [System.Text.Encoding]::UTF8)
  foreach ($requiredReaderJsHook in @('translate_text', 'semanticSearch')) {
    if ($readerJsText -notmatch [regex]::Escape($requiredReaderJsHook)) {
      throw "ui/reader.js missing required reader bridge hook: $requiredReaderJsHook"
    }
  }
  $readerCrossText = [System.IO.File]::ReadAllText((Join-Path $repo 'ui\reader-cross-search-ui.js'), [System.Text.Encoding]::UTF8)
  foreach ($requiredCrossHook in @('reader_cross_search', 'open_book_at', 'pendingCrossSearch', 'semantic_search', 'openSemanticSearch')) {
    if ($readerCrossText -notmatch [regex]::Escape($requiredCrossHook)) {
      throw "ui/reader-cross-search-ui.js missing required cross-search hook: $requiredCrossHook"
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

  Write-Host '== release asset integrity =='
  $releaseScript = [System.IO.File]::ReadAllText((Join-Path $repo 'scripts\release.ps1'), [System.Text.Encoding]::UTF8)
  foreach ($requiredReleaseHook in @('Get-FileHash -LiteralPath $_ -Algorithm SHA256', 'SHA256SUMS.txt')) {
    if ($releaseScript -notmatch [regex]::Escape($requiredReleaseHook)) {
      throw "scripts/release.ps1 missing required release integrity hook: $requiredReleaseHook"
    }
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

  Write-Host '== account storage baseline =='
  $uiJsText = (Get-ChildItem -LiteralPath (Join-Path $repo 'ui') -Filter '*.js' -File |
    Where-Object { $_.Name -notlike 'pdf*.js' } |
    ForEach-Object { [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8) }) -join "`n"
  if ($uiJsText -match 'localStorage\.setItem\([^\n]*password') { throw 'Do not store account passwords in localStorage.' }
  if ($uiJsText -match 'list\.unshift\(\{\s*username,\s*password') { throw 'Saved account list must not persist password.' }
  $syncRs = [System.IO.File]::ReadAllText((Join-Path $repo 'src\sync.rs'), [System.Text.Encoding]::UTF8)
  if ($syncRs -notmatch '#\[serde\(skip_serializing\)\]\s*token:\s*String') {
    throw 'Sync tokens must not be serialized back to the frontend.'
  }
  if ($syncRs -notmatch 'sync_token_protected' -or $syncRs -notmatch 'protect_secret' -or $syncRs -notmatch 'unprotect_secret') {
    throw 'Sync tokens must use protected local storage instead of plaintext metadata.'
  }
  if ($syncRs -match 'set_metadata\("sync_token",\s*(token|res\.token)') {
    throw 'Sync token must not be written directly to the legacy plaintext sync_token field.'
  }
  if ($syncRs -notmatch 'fn\s+normalize_sync_base' -or $syncRs -notmatch 'sync_base_requires_https_except_localhost') {
    throw 'Sync URL normalization and HTTPS policy tests are required.'
  }
  Write-Host '== security baseline =='
  if ($tauriText -match '"csp"\s*:\s*null') { throw 'tauri.conf.json CSP must not be null.' }
  if ($tauriText -match "script-src[^;]*'unsafe-inline'") { throw "script-src must not allow 'unsafe-inline'." }
  if ($tauriText -match "style-src[^;]*'unsafe-inline'") { throw "style-src must not allow 'unsafe-inline'." }
  $srcText = (Get-ChildItem -LiteralPath (Join-Path $repo 'src') -Filter '*.rs' -File -Recurse |
    ForEach-Object { [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8) }) -join "`n"
  if ($srcText -match 'Command::new\("cmd"\)') {
    throw 'Do not open external URLs through cmd.exe; use ShellExecuteW/url_open instead.'
  }
  $httpScanFiles = @()
  $httpScanFiles += Get-Item -LiteralPath (Join-Path $repo 'tauri.conf.json')
  $httpScanFiles += Get-ChildItem -LiteralPath (Join-Path $repo 'src') -File -Recurse |
    Where-Object { $_.FullName -notlike (Join-Path $repo 'src\dict\*') }
  $httpScanFiles += Get-ChildItem -LiteralPath (Join-Path $repo 'ui') -File -Recurse |
    Where-Object { $_.FullName -notlike (Join-Path $repo 'ui\pdfjs\*') }
  $httpScanFiles += Get-ChildItem -LiteralPath (Join-Path $repo 'scripts') -File -Recurse
  $httpHits = @(
    Select-String -LiteralPath ($httpScanFiles | Select-Object -ExpandProperty FullName) -Pattern 'http://' |
      ForEach-Object {
        $rel = $_.Path
        $prefix = $repo.TrimEnd('\') + '\'
        if ($rel.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
          $rel = $rel.Substring($prefix.Length)
        }
        "${rel}:$($_.LineNumber):$($_.Line)"
      }
  )
  $publicHttpHits = @($httpHits | Where-Object {
    $_ -notmatch 'scripts\\check\.ps1' -and
    $_ -notmatch 'starts_with\("http://"\)' -and
    $_ -notmatch 'LEGACY_SYNC_HTTP_URL.*http://117\.72\.220\.69' -and
    $_ -notmatch 'normalize_sync_base\("http://' -and
    $_ -notmatch 'src\\sync\.rs:\d+:\s*let url = format!\("http://\{address\}/sync-test"\);' -and
    $_ -notmatch 'http://(localhost|127\.0\.0\.1|\[::1\]|reader\.localhost|ipc\.localhost|tauri\.localhost)' -and
    $_ -notmatch 'http://<scheme>\.localhost' -and
    $_ -notmatch 'http://www\.w3\.org/'
  })
  if ($publicHttpHits.Count) {
    $publicHttpHits | ForEach-Object { Write-Error $_ }
    throw 'Public HTTP URL found; use HTTPS except for local WebView/debug origins.'
  }
  $readerHtmlPath = Join-Path $repo 'ui\reader.html'
  $readerHtml = [System.IO.File]::ReadAllText($readerHtmlPath, [System.Text.Encoding]::UTF8)
  $iframes = [regex]::Matches($readerHtml, '<iframe\b[^>]*>', 'IgnoreCase')
  foreach ($iframe in $iframes) {
    if ($iframe.Value -notmatch '\bsandbox\s*=') { throw "iframe without sandbox in ui/reader.html: $($iframe.Value)" }
  }
  $mainRs = [System.IO.File]::ReadAllText((Join-Path $repo 'src\main.rs'), [System.Text.Encoding]::UTF8)
  $epubRuntimeRs = [System.IO.File]::ReadAllText((Join-Path $repo 'src\epub_runtime.rs'), [System.Text.Encoding]::UTF8)
  $readerBackendRs = $mainRs + "`n" + $epubRuntimeRs
  if ($readerBackendRs -notmatch 'sanitize_mobi_html\(&raw\)') { throw 'MOBI render path must sanitize raw HTML before embedding.' }
  if ($readerBackendRs -notmatch 'sanitize_book_html\(&body\)' -or $readerBackendRs -notmatch 'sanitize_book_html\(&md_to_html') {
    throw 'EPUB and Markdown render paths must use the shared parser-based sanitizer.'
  }
  if ($readerJsText -notmatch 'ReaderMessageGuard\?\.validateEvent\(e, frame') {
    throw 'Reader message bridge must validate frame source, action and payload bounds.'
  }
  if ($readerInjectedHead -match "localStorage\.setItem\(translateApiStorageKey") {
    throw 'Translation credentials must not be persisted in reader localStorage.'
  }
  if ($readerInjectedHead -notmatch 'credentialConfigId') {
    throw 'Translation requests must pass only a backend credential config ID.'
  }
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
