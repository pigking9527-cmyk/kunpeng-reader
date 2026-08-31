[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Path
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$allowed = @(
  'Cargo.toml',
  'Cargo.lock',
  'tauri.conf.json',
  'tauri.linux.conf.json',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'docs/release/1.1.0-beta.3.md',
  'docs/release/1.1.0-beta.4.md',
  'docs/coordination/ACTIVE_WORK.md',
  '更新.md',
  '开发记录.md',
  '开发文档.md',
  '.github/workflows/ci.yml',
  '.github/workflows/windows-build.yml',
  '.github/workflows/macos-build.yml',
  '.github/workflows/linux-build.yml',
  'scripts/stage-release.ps1',
  'src/newsnow.rs',
  'src/update.rs',
  'src/pdf_support.rs',
  'src/semantic/profile.rs',
  'src/semantic/vector.rs',
  'src/translate/signing.rs'
)
# A release normally stages only the stable list above. The 1.1.0-beta.2
# recovery release is an explicit owner-authorized snapshot of the current
# development worktree. Keep its reviewed file list in the repository instead
# of allowing a broad staging glob or a blanket `git add`.
$beta2Manifest = Join-Path $repoRoot 'docs/release/staging-allowlist-1.1.0-beta.2.txt'
if (Test-Path -LiteralPath $beta2Manifest -PathType Leaf) {
  $allowed += 'docs/release/staging-allowlist-1.1.0-beta.2.txt'
  $beta2Allowed = @(Get-Content -LiteralPath $beta2Manifest -Encoding UTF8 |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') })
  $allowed += $beta2Allowed
}
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
