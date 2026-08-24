[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Test {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$runner = Join-Path $PSScriptRoot 'run-capacity-test-windows.ps1'
Assert-Test (Test-Path -LiteralPath $runner -PathType Leaf) 'Windows capacity runner is missing'
$source = [System.IO.File]::ReadAllText($runner, [System.Text.Encoding]::UTF8)
$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
Assert-Test ($errors.Count -eq 0) ('Windows capacity runner has parse errors: ' + (($errors | ForEach-Object Message) -join '; '))

foreach ($required in @(
    'capacity-k6.js', 'capacity-k6-report.py', 'capacity-client-monitor.py', 'capacity-monitor.py',
    'capacity-fixture-seed.py', 'capacity-direct-control.sh', '--insecure-skip-tls-verify',
    'SYNC_LOAD_TEST_BASE', 'SYNC_LOAD_TEST_TOKENS_FILE', 'independent-vus', 'independent-50',
    'Set-PrivateAcl', 'cleanup --service', 'artifact privacy gate',
    'EntryBoundParameters', 'Resolve-DirectHostFromRootConnection', 'RemoteMonitorSeconds',
    '--allow-absent', 'fixtureSeedAttempted', 'samples -ge 55', 'samples -ge 60',
    'direct_https_restored=true', 'fixture_removed=true'
)) {
    Assert-Test ($source.IndexOf($required, [System.StringComparison]::Ordinal) -ge 0) ("runner is missing required control: $required")
}
Assert-Test ($source -notmatch '(?i)Bearer\s+[A-Za-z0-9._~+/=-]{12,}') 'runner contains a bearer credential'
$endpointScrubbed = $source.Replace('https://127.0.0.1:__PORT__/metrics', '[APPROVED_LOOPBACK_METRICS]')
Assert-Test ($endpointScrubbed -notmatch '(?m)(?:^|[^0-9])(?:[1-9][0-9]{0,2}\.){3}[0-9]{1,3}(?::[0-9]+)?') 'runner contains a hard-coded external IPv4 endpoint'
Assert-Test ($source -notmatch 'SYNC_LOAD_TEST_BASE=.*https?://') 'runner hard-codes the load-test endpoint'
Assert-Test ($source -notmatch 'ssh\s+-i|IdentityFile') 'runner bypasses the approved root wrapper with a key path'

$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$stdout = Join-Path ([System.IO.Path]::GetTempPath()) ('capacity-windows-selftest-' + [Guid]::NewGuid().ToString('N') + '.out')
$stderr = $stdout + '.err'
try {
    $process = Start-Process -FilePath $pwsh -ArgumentList @('-NoLogo', '-NoProfile', '-File', $runner, '-SelfTest') -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
    $process.WaitForExit()
    $result = if (Test-Path -LiteralPath $stdout) { [System.IO.File]::ReadAllText($stdout) } else { '' }
    $errorText = if (Test-Path -LiteralPath $stderr) { [System.IO.File]::ReadAllText($stderr) } else { '' }
    Assert-Test ($process.ExitCode -eq 0) ('runner self-test failed: ' + $errorText.Trim())
    Assert-Test ($result -match 'windows_capacity_runner_self_test=passed') 'runner self-test did not emit its completion marker'
} finally {
    foreach ($path in @($stdout, $stderr)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
    }
}

Write-Output 'test_run_capacity_test_windows=passed'
