param(
  [string]$Version = "",
  [string]$Server = "deploy@117.72.220.69",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\id_ed25519",
  [string]$RemotePath = "/srv/apps/reader-sync-api/updates.json"
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
