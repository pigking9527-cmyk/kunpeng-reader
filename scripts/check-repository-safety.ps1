[CmdletBinding()]
param(
  [switch]$Staged,
  [switch]$AllTracked
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ($Staged -eq $AllTracked) { throw 'Choose exactly one scan target: -Staged or -AllTracked.' }
$paths = if ($Staged) {
  @(git -C $repoRoot diff --cached --name-only --diff-filter=ACMR | Where-Object { $_ })
} else {
  @(git -C $repoRoot ls-files | Where-Object { $_ })
}
if ($LASTEXITCODE -ne 0) { throw 'Unable to list files for the repository safety check.' }

$errors = New-Object System.Collections.Generic.List[string]
$publicHandoffAllowlist = @()
$textExtensions = @('.md', '.txt', '.json', '.yml', '.yaml', '.toml', '.ini', '.env', '.ps1', '.sh')
$secretPatterns = @(
  @{ Name = 'private key'; Pattern = '-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----' },
  @{ Name = 'cloud or provider token'; Pattern = '\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b' },
  @{ Name = 'SSH login to an IP address'; Pattern = '(?i)\b(?:ssh|scp|sftp|rsync)\b[^\r\n]{0,160}\b[A-Za-z0-9._-]+@(?:\d{1,3}\.){3}\d{1,3}' },
  @{ Name = 'SSH identity-file location'; Pattern = '(?i)(?:identity[ _-]?file|SSH[ _-]?(?:identity|key))[\s：:]*[^\r\n]*\.ssh[\\/]id_' },
  @{ Name = 'plaintext credential assignment'; Pattern = '(?im)^\s*(?:password|passwd|secret|token|api[_-]?key)\s*[：:=]\s*["'']?(?!<|\$\{|\$env:|YOUR_|REPLACE_|CHANGE_|TODO|EXAMPLE|NULL\b|NONE\b)[^\s#"'']{8,}' }
)

foreach ($relativePath in $paths) {
  $normalized = $relativePath.Replace('\', '/')
  $fullPath = Join-Path $repoRoot $relativePath
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
  $fileName = [IO.Path]::GetFileName($normalized)
  $extension = [IO.Path]::GetExtension($fileName).ToLowerInvariant()
  if ($normalized -match '(?i)(^|/).*交接.*\.(md|txt)$') { $errors.Add("Private handoff document is not allowed in Git: $normalized") }
  if ($normalized -match '(?i)(^|/).*(handoff|handover).*\.(md|txt)$' -and $publicHandoffAllowlist -notcontains $normalized) { $errors.Add("Handoff document is not on the public allowlist: $normalized") }
  if ($normalized -match '(?i)(^|/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))$') { $errors.Add("Credential-like file name is not allowed in Git: $normalized") }
  if ($textExtensions -notcontains $extension) { continue }
  $content = [IO.File]::ReadAllText($fullPath, [Text.UTF8Encoding]::new($false, $true))
  foreach ($rule in $secretPatterns) {
    if ([regex]::IsMatch($content, $rule.Pattern)) { $errors.Add("Possible $($rule.Name) in $normalized") }
  }
}
if ($errors.Count) {
  Write-Error 'Repository safety check failed:'
  $errors | Sort-Object -Unique | ForEach-Object { Write-Error "- $_" }
  throw 'Remove the private material, move it outside the repository, or replace it with a documented non-sensitive placeholder.'
}
Write-Host "Repository safety check passed ($($paths.Count) file(s) scanned)."
