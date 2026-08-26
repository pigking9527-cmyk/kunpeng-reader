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
    "[string]`$Concurrency = '50'", "[string]`$DurationSeconds = '60'", '[string]$Rounds',
    'Resolve-DiagnosticRounds', 'Rounds cannot be combined with Concurrency or DurationSeconds',
    'round concurrency must be between 1 and 500', 'round duration must be between 30 and 300 seconds',
    'Concurrency must be an integer between 1 and 500', 'DurationSeconds must be an integer between 30 and 300 seconds',
    'combined round duration must not exceed 1200 seconds', 'round-01-vu-25',
    'Set-PrivateAcl', 'cleanup --service', 'artifact privacy gate',
    'Assert-PrivateAclState -Path $wrapper',
    'EntryBoundParameters', 'Resolve-DirectHostFromRootConnection',
    '$remoteMonitorSeconds = $roundDurationSeconds + 15',
    '$watchIterations = ($remoteMonitorSeconds + 20) * 2',
    '$minimumClientSamples = [Math]::Max(1, $roundDurationSeconds - 5)',
    '-ge $minimumClientSamples', '-ge $roundDurationSeconds',
    '--allow-absent', 'pendingFixtureRegistered',
    'direct_https_restored=true', 'fixture_removed=true', '[string]$TestBinarySha256',
    'testBinarySha256', "-cmatch '^[a-f0-9]{64}$'", '--test-binary-sha256',
    'ConvertTo-ShellLiteral $testBinarySha', 'verified-candidate', 'production-equivalent',
    '$direct.binary_mode -eq $expectedBinaryMode', '$status.binary_mode -eq $expectedBinaryMode',
    'binaryMode = $expectedBinaryMode', 'testBinarySha256 = $expectedServiceSha',
    'binary_mode={0}', 'binary provenance', '--expected-service-sha256',
    'identityStable -eq $true', 'test_binary_sha256', 'Stop-CapturedProcessSafe',
    'remote-monitor-watch-start', 'monitor_watch=identity_failed',
    'monitor_watch=stale', 'os.path.getmtime(sys.argv[1]) > 5',
    'remote service identity monitor ended while load was active; load was terminated',
    'local load termination could not be confirmed',
    'Assert-DirectHttpsReachable', 'direct-client-preflight',
    "@('/health', '/ready')", 'ResponseHeadersRead',
    'DangerousAcceptAnyServerCertificateValidator', 'AllowAutoRedirect = $false', 'UseProxy = $false',
    'ProxyEnvironmentVariables', "Environment['NO_PROXY'] = '*'", 'Enter-CapacityRunLock',
    'Start-RemoteCapacityLock', 'Stop-RemoteCapacityLock', 'Invoke-RootCommandWithCapacityLock',
    "lock_directory='/run/lock/kunpeng-capacity'", 'global.lock', 'control="$lock_directory/control"',
    'lease_id=%s', '--kill-after=5s 120s', 'seq 1 520', '$guardianExitedCleanly = $false',
    'Get-PendingFixtureRegisterCommand', 'Get-PendingFixtureRecoveryCommand',
    'fixture-recovery-registration', 'pending-fixture-recovery', 'target_fingerprint',
    '--expected-target-fingerprint', 'database_url + b"\0" + token_hmac_key',
    'KUNPENG_SYNC_TOKEN_HMAC_KEY', 'os.fsync', 'ln -- "$temporary" "$record"',
    'for attempt in 1 2 3', 'recovered_pending_fixtures', 'startup-recovery-gate', 'cleanupVerified',
    "production_unchanged -eq 'true'", "caddy_test_port_reference_count -eq '0'",
    "firewall_source_matches_current_ssh -eq 'true'", "service_restored -eq 'true'",
    'while (-not $k6Handle.Process.WaitForExit(250))',
    'pre-load-lock-fence', 'remote_capacity_lock=pre_load_fenced',
    'load-lock-fence', 'remote_capacity_lock=fenced', '.manifest.pending',
    'remote-monitor-download', 'monitor_pid=%s',
    'Stop-RemoteCapacityMonitor', 'remote_capacity_monitor=running', 'monitor_starttime=%s',
    'remote_capacity_monitor_launch=registered', 'remote_capacity_monitor_launch=cancelled',
    'flock -w 15 -x 9', 'test ! -e "$cancel" || exit 70',
    'f"/proc/{pid}/cmdline"', 'kill -TERM "$pid"', 'kill -KILL "$pid"',
    'remote-monitor-exit-confirmation', 'remote capacity monitor process cleanup failed',
    '$remoteMonitorCleanupVerified = $true', '$remoteMonitorCleanupVerified = $false',
    'run-scoped remote cleanup withheld because remote monitor cleanup was not verified',
    'quarantine="${{run}}.cleanup"', 'mv -T -- "$run" "$quarantine"', 'rm -rf -- "$quarantine"',
    'foreach ($roundPlan in $DiagnosticRounds)', '$artifactPrefix + ''k6-summary.json''',
    'maxActiveVus', 'totalPlannedSeconds', 'roundCount = $roundResults.Count',
    'Invoke-CapacityRun -DiagnosticRounds $roundsToRun'
)) {
    Assert-Test ($source.IndexOf($required, [System.StringComparison]::Ordinal) -ge 0) ("runner is missing required control: $required")
}
Assert-Test ($source -notmatch '(?i)Bearer\s+[A-Za-z0-9._~+/=-]{12,}') 'runner contains a bearer credential'
$endpointScrubbed = $source.Replace('https://127.0.0.1:__PORT__/metrics', '[APPROVED_LOOPBACK_METRICS]')
Assert-Test ($endpointScrubbed -notmatch '(?m)(?:^|[^0-9])(?:[1-9][0-9]{0,2}\.){3}[0-9]{1,3}(?::[0-9]+)?') 'runner contains a hard-coded external IPv4 endpoint'
Assert-Test ($source -notmatch 'SYNC_LOAD_TEST_BASE=.*https?://') 'runner hard-codes the load-test endpoint'
Assert-Test ($source -notmatch 'ssh\s+-i|IdentityFile') 'runner bypasses the approved root wrapper with a key path'
Assert-Test ($source -notmatch "(?<![A-Za-z0-9])[a-f0-9]{64}(?![A-Za-z0-9])") 'runner contains a hard-coded candidate digest'
Assert-Test ($source.IndexOf('$phase = ''remote-monitor-completion''', [System.StringComparison]::Ordinal) -lt 0) 'runner reverted to checking service identity only after load completion'
Assert-Test ($source.IndexOf('$phase = ''pending-fixture-recovery''', [System.StringComparison]::Ordinal) -lt $source.IndexOf('$phase = ''fixture-recovery-registration''', [System.StringComparison]::Ordinal)) 'runner does not recover old fixtures before registering a new one'
Assert-Test ($source.IndexOf('$phase = ''fixture-recovery-registration''', [System.StringComparison]::Ordinal) -lt $source.IndexOf('$phase = ''fixture-seed''', [System.StringComparison]::Ordinal)) 'runner does not persist recovery state before seeding'
Assert-Test ($source.IndexOf('$phase = ''remote-capacity-lock''', [System.StringComparison]::Ordinal) -lt $source.IndexOf('$phase = ''helper-upload''', [System.StringComparison]::Ordinal)) 'runner does not hold the remote global lock before recovery and helper activity'
Assert-Test ($source.IndexOf('seq 1 720', [System.StringComparison]::Ordinal) -lt 0) 'runner reverted to an outer RPC deadline equal to the root-command timeout'
Assert-Test ($source.IndexOf("if (`$release -eq 'remote_capacity_lock=released' -and `$result.ExitCode -eq 0) { return `$true }", [System.StringComparison]::Ordinal) -lt 0) 'runner returns before proving that the actual remote flock is acquirable'
Assert-Test ($source.IndexOf("Write-Output 'active_vus=50'", [System.StringComparison]::Ordinal) -lt 0 -and $source.IndexOf("Write-Output 'planned_seconds=60'", [System.StringComparison]::Ordinal) -lt 0) 'runner still emits hard-coded default load values'
$roundLoopIndex = $source.IndexOf('foreach ($roundPlan in $DiagnosticRounds)', [System.StringComparison]::Ordinal)
$fixtureSeedIndex = $source.IndexOf('$phase = ''fixture-seed''', [System.StringComparison]::Ordinal)
$directPrepareIndex = $source.IndexOf('$phase = ''direct-prepare''', [System.StringComparison]::Ordinal)
$roundManifestIndex = $source.IndexOf('$manifest = [ordered]@{', $roundLoopIndex, [System.StringComparison]::Ordinal)
$mandatoryCleanupIndex = $source.IndexOf('if (-not (Stop-CapturedProcessSafe $k6Handle))', $roundLoopIndex, [System.StringComparison]::Ordinal)
Assert-Test ($fixtureSeedIndex -ge 0 -and $directPrepareIndex -gt $fixtureSeedIndex -and $roundLoopIndex -gt $directPrepareIndex -and $roundManifestIndex -gt $roundLoopIndex -and $mandatoryCleanupIndex -gt $roundManifestIndex) 'multi-round work no longer shares one seed/direct/lock lifecycle followed by one cleanup'
Assert-Test ([regex]::Matches($source, '(?m)^\s*Invoke-CapacityRun -DiagnosticRounds \$roundsToRun\s*$').Count -eq 1) 'runner does not invoke the whole remote lifecycle exactly once for a round plan'
$monitorStartBlockIndex = $source.IndexOf('$phase = ''remote-monitor-start''', [System.StringComparison]::Ordinal)
$monitorGuardIndex = $source.IndexOf('remote_capacity_monitor_launch=registered', $monitorStartBlockIndex, [System.StringComparison]::Ordinal)
$monitorLaunchIndex = $source.IndexOf("nohup bash -c 'run_capacity_monitor", $monitorStartBlockIndex, [System.StringComparison]::Ordinal)
$monitorCancelIndex = $source.IndexOf('remote_capacity_monitor_launch=cancelled', [System.StringComparison]::Ordinal)
$monitorMissingIdentityIndex = $source.IndexOf('if test ! -e "$identity"; then', $source.IndexOf('function Stop-RemoteCapacityMonitor', [System.StringComparison]::Ordinal), [System.StringComparison]::Ordinal)
Assert-Test ($monitorGuardIndex -ge 0 -and $monitorGuardIndex -lt $monitorLaunchIndex) 'remote monitor launch intent is not durable before the detached launcher starts'
Assert-Test ($monitorCancelIndex -ge 0 -and $monitorCancelIndex -lt $monitorMissingIdentityIndex) 'remote monitor cleanup can still accept a missing identity before cancelling a pending launcher'
Assert-Test ([regex]::IsMatch($source, 'ensure_cancel\r?\nif test ! -e "\$guard"; then')) 'remote monitor cleanup does not publish cancellation before accepting a missing launch guard'
$earlyMonitorCancelIndex = $source.IndexOf('cancel="${identity}.cancel"', $monitorStartBlockIndex, [System.StringComparison]::Ordinal)
$monitorServiceCheckIndex = $source.IndexOf('case "$service" in', $monitorStartBlockIndex, [System.StringComparison]::Ordinal)
Assert-Test ($earlyMonitorCancelIndex -gt $monitorStartBlockIndex -and $earlyMonitorCancelIndex -lt $monitorServiceCheckIndex) 'a delayed remote monitor start does not check the cancellation marker first'
Assert-Test ($source.IndexOf('kill "$monitor_pid" 2>/dev/null || true', [System.StringComparison]::Ordinal) -lt 0) 'remote monitor startup still sends a signal to an unverified PID'
$remoteRunCleanupFunctionIndex = $source.IndexOf('function Get-RemoteRunCleanupCommand', [System.StringComparison]::Ordinal)
$remoteMonitorStopFunctionIndex = $source.IndexOf('function Stop-RemoteCapacityMonitor', $remoteRunCleanupFunctionIndex, [System.StringComparison]::Ordinal)
$remoteRunCleanupSource = $source.Substring($remoteRunCleanupFunctionIndex, $remoteMonitorStopFunctionIndex - $remoteRunCleanupFunctionIndex)
$remoteRunRenameIndex = $remoteRunCleanupSource.IndexOf('mv -T -- "$run" "$quarantine"', [System.StringComparison]::Ordinal)
$remoteRunDeleteIndex = $remoteRunCleanupSource.IndexOf('rm -rf -- "$quarantine"', [System.StringComparison]::Ordinal)
Assert-Test ($remoteRunRenameIndex -ge 0 -and $remoteRunDeleteIndex -gt $remoteRunRenameIndex -and $remoteRunCleanupSource.IndexOf('rm -rf -- "$run"', [System.StringComparison]::Ordinal) -lt 0) 'run-scoped cleanup can expose a partial-delete window to a delayed monitor launcher'
$remoteCleanupGateIndex = $source.IndexOf('if ($remoteInitialized -and $remoteMonitorCleanupVerified)', [System.StringComparison]::Ordinal)
$gatedRemoteCleanupCallIndex = $source.IndexOf('Get-RemoteRunCleanupCommand -RemoteRoot $remoteRoot -RemoteRun $remoteRun', $remoteCleanupGateIndex, [System.StringComparison]::Ordinal)
$withheldRemoteCleanupIndex = $source.IndexOf('run-scoped remote cleanup withheld because remote monitor cleanup was not verified', $remoteCleanupGateIndex, [System.StringComparison]::Ordinal)
Assert-Test ($remoteCleanupGateIndex -ge 0 -and $gatedRemoteCleanupCallIndex -gt $remoteCleanupGateIndex -and $withheldRemoteCleanupIndex -gt $gatedRemoteCleanupCallIndex) 'run-scoped evidence can still be deleted without verified remote monitor cleanup'
$cleanupGateIndex = $source.IndexOf('if ($cleanupFailures.Count -gt 0)', [System.StringComparison]::Ordinal)
$manifestPrivacyIndex = $source.IndexOf('Assert-ArtifactSafe -Paths @($manifestTemporary)', [System.StringComparison]::Ordinal)
$manifestPublishIndex = $source.IndexOf('[System.IO.File]::Move($manifestTemporary, $manifestPath)', [System.StringComparison]::Ordinal)
Assert-Test ($cleanupGateIndex -ge 0 -and $manifestPrivacyIndex -gt $cleanupGateIndex -and $manifestPublishIndex -gt $manifestPrivacyIndex) 'runner publishes a complete manifest before mandatory cleanup and privacy validation succeed'
$allRemoteUploads = [regex]::Matches($source, '(?m)^\s*Send-RemoteFile\s+\$wrapper\s+').Count
$approvedRemoteUploads = [regex]::Matches($source, '(?m)^\s*Send-RemoteFile\s+\$wrapper\s+\$(?:seederSource|directSource|remoteMonitorSource)\s+\$remote(?:Seeder|Direct|Monitor)\s*$').Count
Assert-Test ($allRemoteUploads -eq 3 -and $approvedRemoteUploads -eq 3) 'runner uploads something other than the three approved helper scripts'

$readme = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\README.md'), [System.Text.Encoding]::UTF8)
Assert-Test ($readme.Contains('不会再次上传或替换候选二进制', [System.StringComparison]::Ordinal)) 'README does not distinguish helper transfer from candidate binary upload'
Assert-Test (-not $readme.Contains('日常 Windows 一键复测不会编译、不会上传', [System.StringComparison]::Ordinal)) 'README still claims that the daily runner uploads nothing'
Assert-Test ($readme.Contains("-Concurrency 75 -DurationSeconds 90", [System.StringComparison]::Ordinal) -and $readme.Contains("-Rounds '25x60,50x60,100x90'", [System.StringComparison]::Ordinal)) 'README is missing parameterized Windows examples'
Assert-Test ($readme.Contains('non-capacity-diagnostic', [System.StringComparison]::Ordinal) -and $readme.Contains('不能代替固定 20 分钟容量曲线', [System.StringComparison]::Ordinal)) 'README does not preserve the non-capacity classification'

$agents = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\..\..\AGENTS.md'), [System.Text.Encoding]::UTF8)
Assert-Test ($agents.Contains('pwsh -NoProfile -File .\server\reader-sync-api-rs\scripts\run-capacity-test-windows.ps1', [System.StringComparison]::Ordinal)) 'AGENTS.md is missing the stable Windows command'
Assert-Test ($agents.Contains("-Rounds '25x60,50x60,100x90'", [System.StringComparison]::Ordinal) -and $agents.Contains('不得替代固定 20 分钟容量曲线', [System.StringComparison]::Ordinal)) 'AGENTS.md is missing the multi-round or evidence boundary guidance'

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
