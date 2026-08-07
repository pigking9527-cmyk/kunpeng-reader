param(
  [string]$Version = "",
  [string]$Server = $env:KUNPENG_RELEASE_SERVER,
  [string]$IdentityFile = $env:KUNPENG_RELEASE_IDENTITY_FILE,
  [string]$RemotePath = $env:KUNPENG_RELEASE_REMOTE_PATH
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "server\reader-sync-api\updates.json"

function Get-CargoVersion {
  $cargo = Join-Path $repoRoot "Cargo.toml"
  $line = Select-String -LiteralPath $cargo -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
  if (-not $line) { throw "Cannot read version from Cargo.toml." }
  return $line.Matches[0].Groups[1].Value
}

if (-not $Version) { $Version = Get-CargoVersion }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing update manifest: $manifestPath" }
if ([string]::IsNullOrWhiteSpace($Server)) {
  throw "Release server is required. Pass -Server or set KUNPENG_RELEASE_SERVER outside the repository."
}
if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
  throw "SSH identity file is required. Pass -IdentityFile or set KUNPENG_RELEASE_IDENTITY_FILE outside the repository."
}
if ([string]::IsNullOrWhiteSpace($RemotePath)) {
  throw "Remote manifest path is required. Pass -RemotePath or set KUNPENG_RELEASE_REMOTE_PATH outside the repository."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
if ([string]$manifest.latest -ne $Version) {
  throw "Update manifest latest ($($manifest.latest)) does not match release version ($Version). Update server/reader-sync-api/updates.json before publishing."
}
if (-not $manifest.releases.ContainsKey($Version)) {
  throw "Update manifest has no release entry for $Version."
}
if ([string]::IsNullOrWhiteSpace([string]$manifest.releases[$Version].release_notes)) {
  throw "Update manifest release_notes for $Version is empty."
}
if (-not (Test-Path -LiteralPath $IdentityFile)) { throw "SSH identity file not found: $IdentityFile" }

$remoteTemp = "/tmp/kunpeng-reader-updates-$Version-$PID.json"
Write-Host "== upload server update manifest v$Version =="
& scp -i $IdentityFile -o BatchMode=yes $manifestPath "${Server}:$remoteTemp"
if ($LASTEXITCODE -ne 0) { throw "Upload update manifest failed." }
try {
  & ssh -i $IdentityFile -o BatchMode=yes $Server "sudo install -m 0644 '$remoteTemp' '$RemotePath' && rm -f '$remoteTemp'"
  if ($LASTEXITCODE -ne 0) { throw "Install update manifest on server failed." }
} finally {
  # Best effort cleanup; does not affect a successfully installed manifest.
  & ssh -i $IdentityFile -o BatchMode=yes $Server "rm -f '$remoteTemp'" 2>$null
}
Write-Host "Server update manifest published: $RemotePath (v$Version)"
