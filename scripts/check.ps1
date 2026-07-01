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

  Write-Host 'All checks passed.'
} finally {
  Pop-Location
}
