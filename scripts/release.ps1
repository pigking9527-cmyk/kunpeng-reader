param(
  [string]$Version = "",
  [string]$Repo = $env:KUNPENG_RELEASE_REPOSITORY,
  [switch]$SkipChecks,
  [switch]$SkipBuild,
  [switch]$SkipInstaller,
  [switch]$SkipPush,
  [switch]$SkipGitHubRelease,
  [switch]$Draft,
  [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

& node (Join-Path $repoRoot "scripts/assert-public-release-allowed.mjs")
if ($LASTEXITCODE -ne 0) { throw "Public release is paused by the repository license policy." }

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Body
  )
  Write-Host "== $Name =="
  $global:LASTEXITCODE = 0
  & $Body
  if ($LASTEXITCODE -ne 0) {
    throw "Release step failed ($Name) with exit code $LASTEXITCODE."
  }
}

function Get-CargoVersion {
  $cargo = Join-Path $repoRoot "Cargo.toml"
  $line = Select-String -LiteralPath $cargo -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
  if (-not $line) { throw "Cannot read version from Cargo.toml." }
  return $line.Matches[0].Groups[1].Value
}

function Assert-CleanWorktree {
  if ($AllowDirty) { return }
  $dirty = git -C $repoRoot status --porcelain
  if ($dirty) {
    $dirty | ForEach-Object { Write-Host $_ }
    throw "Working tree is not clean. Commit changes first or pass -AllowDirty."
  }
}

function Get-ChangelogNotes {
  param([string]$Ver)
  $path = Join-Path $repoRoot "CHANGELOG.md"
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return "v$Ver" }
  $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  $escaped = [regex]::Escape($Ver)
  # Changelog headings may include a human-readable release date, for example
  # `## v1.11.1 - 2026-08-05`.  Accept that suffix while still stopping at the
  # next version heading so GitHub Release notes never silently fall back to a
  # bare version number.
  $m = [regex]::Match($text, "(?ms)^##\s+v$escaped(?:\s+-[^\r\n]*)?\s*\r?\n(?<body>.*?)(?=^##\s+v|\z)")
  if ($m.Success) { return $m.Groups["body"].Value.Trim() }
  return "v$Ver"
}

function Copy-ReleaseAssets {
  param([string]$Ver)
  $portable = Get-Item -LiteralPath (Join-Path $repoRoot "鲲鹏阅读器.exe") -ErrorAction SilentlyContinue
  $installerDir = Join-Path $repoRoot "target\release\bundle\nsis"
  $installer = Get-ChildItem -LiteralPath $installerDir -Filter "*_$($Ver)_x64-setup.exe" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $portable) { throw "Portable reader executable not found in repo root." }
  if (-not $installer) { throw "Installer not found for version $Ver in $installerDir." }

  $dir = Join-Path $env:TEMP "kunpeng-release-v$Ver"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $portableOut = Join-Path $dir "Kunpeng-Reader-v$Ver-portable.exe"
  $installerOut = Join-Path $dir "Kunpeng-Reader-v$Ver-x64-setup.exe"
  Copy-Item -LiteralPath $portable.FullName -Destination $portableOut -Force
  Copy-Item -LiteralPath $installer.FullName -Destination $installerOut -Force

  $checksumOut = Join-Path $dir "SHA256SUMS.txt"
  $checksumLines = @($portableOut, $installerOut) | ForEach-Object {
    $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($_))"
  }
  [IO.File]::WriteAllLines($checksumOut, $checksumLines, [Text.UTF8Encoding]::new($false))
  return @($portableOut, $installerOut, $checksumOut)
}

function Assert-TagPointsAtHead {
  param([string]$Tag)
  $tagCommit = git rev-parse --verify "$Tag^{commit}"
  if ($LASTEXITCODE -ne 0) { throw "Cannot resolve release tag $Tag." }
  $headCommit = git rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0) { throw "Cannot resolve HEAD for release." }
  if ($tagCommit.Trim() -ne $headCommit.Trim()) {
    throw "Release tag $Tag points at $($tagCommit.Trim()), not current HEAD $($headCommit.Trim())."
  }
}

Push-Location $repoRoot
try {
  if (-not $Version) { $Version = Get-CargoVersion }
  $tag = "v$Version"
  Write-Host "Release: $tag"

  if (-not $SkipGitHubRelease -and [string]::IsNullOrWhiteSpace($Repo)) {
    throw "Missing KUNPENG_RELEASE_REPOSITORY. Configure the new owner/repository outside the repository."
  }

  if (-not $SkipBuild) {
    $updateBase = [Environment]::GetEnvironmentVariable('KUNPENG_UPDATE_BASE')
    if ([string]::IsNullOrWhiteSpace($updateBase) -or $updateBase -notmatch '^https://[^\s/]+(?:/[^\s]*)?$') {
      throw "Missing or invalid KUNPENG_UPDATE_BASE. Official builds require an HTTPS update fallback endpoint outside the repository."
    }
  }

  Invoke-Step "worktree" { Assert-CleanWorktree }

  if (-not $SkipChecks) {
    Invoke-Step "checks" { powershell -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\check.ps1") }
  }

  if (-not $SkipBuild) {
    Invoke-Step "portable build" {
      powershell -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\build-release.ps1") -SkipIconCacheRefresh
    }
  }

  if (-not $SkipInstaller) {
    Invoke-Step "installer build" {
      cargo tauri build --config (Join-Path $repoRoot "packaging\windows\tauri.release.conf.json")
    }
  }

  $assets = Invoke-Step "prepare assets" { Copy-ReleaseAssets -Ver $Version }
  $notesPath = Join-Path $env:TEMP "kunpeng-release-v$Version-notes.md"
  Get-ChangelogNotes -Ver $Version | Set-Content -LiteralPath $notesPath -Encoding UTF8

  Invoke-Step "tag" {
    $existing = git tag --list $tag
    if (-not $existing) {
      git tag -a $tag -m $tag
    } else {
      Write-Host "Tag exists: $tag"
    }
    Assert-TagPointsAtHead -Tag $tag
  }

  if (-not $SkipPush) {
    Invoke-Step "push" {
      git push origin main
      git push origin $tag
    }
  }

  if (-not $SkipGitHubRelease) {
    Invoke-Step "github release" {
      $exists = $true
      gh release view $tag --repo $Repo | Out-Null
      if ($LASTEXITCODE -ne 0) { $exists = $false }

      if ($exists) {
        gh release edit $tag --repo $Repo --title $tag --notes-file $notesPath
      } else {
        $args = @("release", "create", $tag, "--repo", $Repo, "--verify-tag", "--title", $tag, "--notes-file", $notesPath)
        if ($Draft) { $args += "--draft" }
        gh @args
      }
      gh release upload $tag $assets[0] $assets[1] $assets[2] --repo $Repo --clobber
      gh release view $tag --repo $Repo --json url,assets
    }
  }
} finally {
  Pop-Location
}
