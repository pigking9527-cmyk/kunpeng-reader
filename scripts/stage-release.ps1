[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Path
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$allowed = @(
  'Cargo.toml',
  'tauri.conf.json',
  'tauri.linux.conf.json',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  '更新.md',
  '开发记录.md',
  '开发文档.md',
  '.github/workflows/ci.yml',
  '.github/workflows/windows-build.yml',
  '.github/workflows/macos-build.yml',
  '.github/workflows/linux-build.yml',
  'scripts/stage-release.ps1',
  'src/newsnow.rs',
  'src/pdf_support.rs',
  'src/semantic/profile.rs',
  'src/semantic/vector.rs',
  'src/translate/signing.rs'
)
foreach ($item in $Path) {
  $relative = $item.Replace('\', '/')
  $isReleaseNotes = $relative -match '^RELEASE_NOTES_v\d+\.\d+\.\d+\.md$'
  if (-not $isReleaseNotes -and $allowed -notcontains $relative) { throw "Release staging only accepts approved release files. Rejected: $relative" }
  $pathOnDisk = Join-Path $repoRoot $item
  $isTrackedDeletion = -not (Test-Path -LiteralPath $pathOnDisk -PathType Leaf) -and (git -C $repoRoot ls-files --error-unmatch -- $item 2>$null)
  if (-not (Test-Path -LiteralPath $pathOnDisk -PathType Leaf) -and -not $isTrackedDeletion) { throw "Release staging file does not exist: $relative" }
}
& git -C $repoRoot add -- $Path
if ($LASTEXITCODE -ne 0) { throw 'git add failed.' }
& (Join-Path $PSScriptRoot 'check-repository-safety.ps1') -Staged
if ($LASTEXITCODE -ne 0) { throw 'Release staging safety check failed.' }
Write-Host 'Approved release files staged. Review with: git diff --cached --name-status'
