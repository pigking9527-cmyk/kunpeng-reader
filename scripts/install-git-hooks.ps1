$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
git -C $repoRoot config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw 'Unable to configure the repository Git hooks path.' }
Write-Host 'Installed repository hooks from .githooks.'