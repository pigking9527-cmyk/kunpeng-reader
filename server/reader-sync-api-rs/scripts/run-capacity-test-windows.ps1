[CmdletBinding()]
param(
    [switch]$SelfTest,
    [string]$Concurrency = '50',
    [string]$DurationSeconds = '60',
    [string]$Rounds,
    [string]$PrivateConfigPath,
    [string]$RootWrapperPath,
    [string]$SshAlias,
    [string]$K6Path,
    [string]$PythonPath,
    [string]$TokensPath,
    [string]$ReportDirectory,
    [string]$DirectHost,
    [string]$RemoteRunRoot,
    [string]$TestService,
    [string]$ProductionService,
    [string]$TestBinarySha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ExpectedK6Version = '1.2.3'
$script:ExpectedTokenCount = 2048
$script:Profile = 'catchup'
$script:ExecutionModel = 'independent-vus'
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:EntryBoundParameters = @{} + $PSBoundParameters
$script:ProxyEnvironmentVariables = @(
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
    'NO_PROXY', 'no_proxy'
)

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Resolve-DiagnosticRounds {
    param(
        [string]$DefaultConcurrency,
        [string]$DefaultDurationSeconds,
        [AllowEmptyString()][string]$RoundSpecification,
        [bool]$ConcurrencyWasBound,
        [bool]$DurationWasBound,
        [bool]$RoundsWasBound
    )
    if ($RoundsWasBound) {
        Assert-Condition (-not [string]::IsNullOrWhiteSpace($RoundSpecification)) 'round plan must not be empty'
        Assert-Condition (-not $ConcurrencyWasBound -and -not $DurationWasBound) 'Rounds cannot be combined with Concurrency or DurationSeconds'
        Assert-Condition ($RoundSpecification -match '^\s*[0-9]{1,3}[xX][0-9]{1,3}(?:\s*,\s*[0-9]{1,3}[xX][0-9]{1,3})*\s*$') 'Rounds must use comma-separated CONCURRENCYxSECONDS entries'
        $entries = @($RoundSpecification -split ',' | ForEach-Object { $_.Trim() })
        Assert-Condition ($entries.Count -ge 1 -and $entries.Count -le 12) 'Rounds must contain between 1 and 12 entries'
        $resolved = [System.Collections.Generic.List[object]]::new()
        $totalSeconds = 0
        for ($index = 0; $index -lt $entries.Count; $index++) {
            $parts = $entries[$index] -split '[xX]'
            $roundConcurrency = [int]$parts[0]
            $roundDuration = [int]$parts[1]
            Assert-Condition ($roundConcurrency -ge 1 -and $roundConcurrency -le 500) 'round concurrency must be between 1 and 500'
            Assert-Condition ($roundDuration -ge 30 -and $roundDuration -le 300) 'round duration must be between 30 and 300 seconds'
            $totalSeconds += $roundDuration
            $resolved.Add([pscustomobject]@{
                StageName = ('round-{0:d2}-vu-{1}' -f ($index + 1), $roundConcurrency)
                Concurrency = $roundConcurrency
                DurationSeconds = $roundDuration
            })
        }
        Assert-Condition ($totalSeconds -le 1200) 'combined round duration must not exceed 1200 seconds'
        return @($resolved)
    }

    $parsedConcurrency = 0
    $parsedDurationSeconds = 0
    Assert-Condition ($DefaultConcurrency -cmatch '^[0-9]{1,3}$' -and [int]::TryParse($DefaultConcurrency, [ref]$parsedConcurrency) -and $parsedConcurrency -ge 1 -and $parsedConcurrency -le 500) 'Concurrency must be an integer between 1 and 500'
    Assert-Condition ($DefaultDurationSeconds -cmatch '^[0-9]{1,3}$' -and [int]::TryParse($DefaultDurationSeconds, [ref]$parsedDurationSeconds) -and $parsedDurationSeconds -ge 30 -and $parsedDurationSeconds -le 300) 'DurationSeconds must be an integer between 30 and 300 seconds'
    return @([pscustomobject]@{
        StageName = "independent-$parsedConcurrency"
        Concurrency = $parsedConcurrency
        DurationSeconds = $parsedDurationSeconds
    })
}

function Get-AbsolutePath {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Test-PathWithin {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Root)
    $fullPath = (Get-AbsolutePath $Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $fullRoot = (Get-AbsolutePath $Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    return $fullPath.StartsWith($fullRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-LocalPrivatePath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [switch]$MustExist,
        [switch]$Leaf
    )
    $full = Get-AbsolutePath $Path
    Assert-Condition (-not (Test-PathWithin $full $RepositoryRoot) -and $full -ne (Get-AbsolutePath $RepositoryRoot)) 'private path must remain outside the repository'
    if ($MustExist) {
        Assert-Condition (Test-Path -LiteralPath $full -PathType $(if ($Leaf) { 'Leaf' } else { 'Any' })) 'required private path is unavailable'
    }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        Assert-Condition (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) 'private path must not be a reparse point'
    }
    return $full
}

function Assert-SafeAlias {
    param([string]$Value)
    Assert-Condition ($Value -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') 'SSH alias is invalid'
}

function Assert-TestServiceName {
    param([string]$Value)
    Assert-Condition ($Value -match '^[A-Za-z0-9_.@-]*dev-test[A-Za-z0-9_.@-]*\.service$') 'service must be an explicitly disposable dev-test systemd unit'
}

function Assert-OptionalProductionServiceName {
    param([string]$Value, [string]$TestValue)
    if ([string]::IsNullOrWhiteSpace($Value)) { return }
    Assert-Condition ($Value -match '^[A-Za-z0-9_.@-]+\.service$') 'production service label is invalid'
    Assert-Condition ($Value -ne $TestValue) 'test and production service labels must differ'
}

function Assert-OptionalTestBinarySha256 {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return }
    Assert-Condition ($Value -cmatch '^[a-f0-9]{64}$') 'approved test binary SHA-256 is invalid'
}

function Assert-RemoteRoot {
    param([string]$Value)
    Assert-Condition ($Value -match '^/[A-Za-z0-9._/-]+$') 'remote run root must be a safe absolute POSIX path'
    Assert-Condition ($Value -notmatch '(^|/)\.\.?(?:/|$)') 'remote run root must not contain dot segments'
    Assert-Condition ($Value -ne '/' -and $Value.Length -ge 12) 'remote run root is too broad'
    Assert-Condition ($Value -match '(?i)capacity') 'remote run root must be capacity-specific'
    return $Value.TrimEnd('/')
}

function Assert-DirectHost {
    param([string]$Value)
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($Value)) 'direct test host is required'
    Assert-Condition ($Value -notmatch '[/@\\?#]') 'direct test host must be a bare address or DNS name'
    $address = $null
    if ([System.Net.IPAddress]::TryParse($Value, [ref]$address)) {
        Assert-Condition (-not [System.Net.IPAddress]::IsLoopback($address)) 'direct test host must not be loopback'
        Assert-Condition (-not $address.Equals([System.Net.IPAddress]::Any) -and -not $address.Equals([System.Net.IPAddress]::IPv6Any)) 'direct test host must not be unspecified'
        return
    }
    $kind = [System.Uri]::CheckHostName($Value)
    Assert-Condition ($kind -eq [System.UriHostNameType]::Dns) 'direct test host is invalid'
    Assert-Condition ($Value -ne 'localhost') 'direct test host must be the isolated external test endpoint'
}

function Assert-FixtureId {
    param([string]$Value)
    Assert-Condition ($Value -cmatch '^w[a-f0-9]{11}$') 'fixture ID is invalid'
}

function Get-ConfigValue {
    param(
        [hashtable]$Bound,
        [hashtable]$Config,
        [string]$ParameterName,
        [string]$ConfigName,
        [AllowNull()][object]$Default
    )
    if ($Bound.ContainsKey($ParameterName)) { return $Bound[$ParameterName] }
    if ($Config.ContainsKey($ConfigName)) { return $Config[$ConfigName] }
    return $Default
}

function Read-PrivateConfig {
    param([string]$Path, [bool]$Explicit, [string]$RepositoryRoot)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($Explicit) { throw 'explicit private config is unavailable' }
        return @{}
    }
    $null = Assert-LocalPrivatePath -Path $Path -RepositoryRoot $RepositoryRoot -MustExist -Leaf
    Assert-PrivateAclState -Path $Path
    try {
        $value = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -AsHashtable
    } catch {
        throw 'private config is not valid JSON'
    }
    Assert-Condition ($value -is [hashtable]) 'private config must be a JSON object'
    $allowed = @(
        'scope', 'sshAlias', 'rootWrapperPath', 'k6Path', 'pythonPath', 'tokensPath',
        'reportDirectory', 'directHost', 'remoteRunRoot', 'testService', 'productionService',
        'testBinarySha256'
    )
    foreach ($key in $value.Keys) {
        Assert-Condition ($key -in $allowed) 'private config contains an unsupported field'
        Assert-Condition ($value[$key] -is [string]) 'private config values must be strings'
    }
    Assert-Condition ($value.ContainsKey('scope') -and $value.scope -eq 'disposable-dev-test') 'private config scope is not disposable-dev-test'
    return $value
}

function Assert-PrivateAclState {
    param([Parameter(Mandatory)][string]$Path)
    Assert-Condition ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) 'private ACL enforcement requires Windows'
    $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $actual = Get-Acl -LiteralPath $Path
    Assert-Condition $actual.AreAccessRulesProtected 'private ACL inheritance remains enabled'
    $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $expected = @($current.Value, $system.Value)
    Assert-Condition ($rules.Count -eq 2) 'private ACL must contain exactly two principals'
    foreach ($rule in $rules) {
        Assert-Condition ($rule.IdentityReference.Value -in $expected) 'private ACL contains an unexpected principal'
        Assert-Condition ($rule.AccessControlType -eq $allow -and -not $rule.IsInherited) 'private ACL contains a deny or inherited rule'
        Assert-Condition (($rule.FileSystemRights -band $rights) -eq $rights) 'private ACL is missing full control'
    }
}

function Set-PrivateAcl {
    param([Parameter(Mandatory)][string]$Path, [switch]$Directory)
    Assert-Condition ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) 'private ACL enforcement requires Windows'
    $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    if ($Directory) {
        $security = [System.Security.AccessControl.DirectorySecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        $propagation = [System.Security.AccessControl.PropagationFlags]::None
        $security.SetOwner($current)
        $security.SetAccessRuleProtection($true, $false)
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, $rights, $inheritance, $propagation, $allow))
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, $rights, $inheritance, $propagation, $allow))
    } else {
        $security = [System.Security.AccessControl.FileSecurity]::new()
        $security.SetOwner($current)
        $security.SetAccessRuleProtection($true, $false)
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, $rights, $allow))
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, $rights, $allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $security
    Assert-PrivateAclState -Path $Path
}

function Test-TokenFile {
    param([string]$Path, [int]$ExpectedCount = $script:ExpectedTokenCount)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'token file must not be a reparse point' }
    try { $lines = [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8) } catch { return $false }
    if ($lines.Count -ne $ExpectedCount) { return $false }
    $unique = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($raw in $lines) {
        $token = $raw.Trim()
        if ($token.Length -lt 16 -or $token.Length -gt 8192 -or $token -match '\s') { return $false }
        if (-not $unique.Add($token)) { return $false }
    }
    return $unique.Count -eq $ExpectedCount
}

function Write-PrivateBytes {
    param([string]$Path, [byte[]]$Bytes)
    $writePhase = 'parent'
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $parent
        Set-PrivateAcl -Path $parent -Directory
    }
    $temporary = Join-Path $parent ('.partial-' + [System.Guid]::NewGuid().ToString('N'))
    try {
        $writePhase = 'temporary-create'
        $stream = [System.IO.FileStream]::new($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $stream.Dispose()
        $writePhase = 'temporary-acl'
        Set-PrivateAcl -Path $temporary
        $writePhase = 'temporary-write'
        [System.IO.File]::WriteAllBytes($temporary, $Bytes)
        $writePhase = 'target-validation'
        if (Test-Path -LiteralPath $Path) {
            Assert-Condition (Test-Path -LiteralPath $Path -PathType Leaf) 'private output target must be a file'
            $existing = Get-Item -LiteralPath $Path -Force
            Assert-Condition (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) 'private output target must not be a reparse point'
            Remove-Item -LiteralPath $Path -Force
        }
        $writePhase = 'target-move'
        [System.IO.File]::Move($temporary, $Path)
        $writePhase = 'target-acl-verification'
        Assert-PrivateAclState -Path $Path
    } catch {
        throw "private output failed at $writePhase`: $($_.Exception.Message)"
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Write-PrivateText {
    param([string]$Path, [string]$Text)
    Write-PrivateBytes -Path $Path -Bytes $script:Utf8NoBom.GetBytes($Text)
}

function Enter-CapacityRunLock {
    param([Parameter(Mandatory)][string]$Path)
    $existed = Test-Path -LiteralPath $Path
    if ($existed) {
        Assert-Condition (Test-Path -LiteralPath $Path -PathType Leaf) 'capacity run lock target must be a file'
        $item = Get-Item -LiteralPath $Path -Force
        Assert-Condition (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) 'capacity run lock must not be a reparse point'
        Assert-PrivateAclState -Path $Path
    }
    try {
        $stream = [System.IO.FileStream]::new(
            $Path,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch {
        throw 'another Windows capacity run is already active'
    }
    try {
        if ($existed) { Assert-PrivateAclState -Path $Path } else { Set-PrivateAcl -Path $Path }
        return $stream
    } catch {
        $stream.Dispose()
        throw
    }
}

function New-ProcessInfo {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory
    )
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    if ($WorkingDirectory) { $info.WorkingDirectory = $WorkingDirectory }
    foreach ($argument in $Arguments) { $null = $info.ArgumentList.Add($argument) }
    foreach ($key in $Environment.Keys) { $info.Environment[$key] = [string]$Environment[$key] }
    return $info
}

function Start-CapturedProcess {
    param([System.Diagnostics.ProcessStartInfo]$StartInfo)
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $StartInfo
    Assert-Condition $process.Start() 'process could not be started'
    return [pscustomobject]@{
        Process = $process
        Stdout = $process.StandardOutput.ReadToEndAsync()
        Stderr = $process.StandardError.ReadToEndAsync()
    }
}

function Complete-CapturedProcess {
    param([object]$Handle, [int]$TimeoutMilliseconds, [switch]$TerminateOnTimeout)
    if (-not $Handle.Process.WaitForExit($TimeoutMilliseconds)) {
        if ($TerminateOnTimeout) {
            try { $Handle.Process.Kill($true) } catch { try { Stop-Process -Id $Handle.Process.Id -Force } catch {} }
            $Handle.Process.WaitForExit(5000) | Out-Null
        }
        throw 'child process timed out'
    }
    $Handle.Process.WaitForExit()
    return [pscustomobject]@{
        ExitCode = $Handle.Process.ExitCode
        Stdout = $Handle.Stdout.GetAwaiter().GetResult()
        Stderr = $Handle.Stderr.GetAwaiter().GetResult()
    }
}

function Stop-CapturedProcessSafe {
    param([AllowNull()][object]$Handle)
    if ($null -eq $Handle) { return $true }
    $stopped = $false
    try {
        if (-not $Handle.Process.HasExited) {
            try { $Handle.Process.Kill($true) } catch { try { Stop-Process -Id $Handle.Process.Id -Force } catch {} }
        }
        $Handle.Process.WaitForExit(5000) | Out-Null
        if (-not $Handle.Process.HasExited) {
            try { Stop-Process -Id $Handle.Process.Id -Force } catch {}
            $Handle.Process.WaitForExit(5000) | Out-Null
        }
        if ($Handle.Process.HasExited) {
            $Handle.Process.WaitForExit()
            try { $null = $Handle.Stdout.GetAwaiter().GetResult() } catch {}
            try { $null = $Handle.Stderr.GetAwaiter().GetResult() } catch {}
            $stopped = $true
        }
    } catch {}
    return $stopped
}

function New-K6ProcessInfo {
    param(
        [string]$Executable,
        [string]$ScriptPath,
        [string]$SummaryPath,
        [string]$WorkingDirectory,
        [string]$BaseUrl,
        [string]$TokenFile,
        [string]$StageName,
        [int]$DurationSeconds,
        [int]$Concurrency
    )
    $environment = @{
        K6_NO_USAGE_REPORT = 'true'
        SYNC_LOAD_TEST_TOKENS_FILE = $TokenFile
        SYNC_LOAD_TEST_BASE = $BaseUrl
        SYNC_LOAD_TEST_STAGE_SECONDS = [string]$DurationSeconds
        SYNC_LOAD_TEST_PROFILE = $script:Profile
        SYNC_LOAD_TEST_EXECUTION_MODEL = $script:ExecutionModel
        SYNC_LOAD_TEST_SINGLE_STAGE_NAME = $StageName
        SYNC_LOAD_TEST_SINGLE_CONCURRENCY = [string]$Concurrency
        SYNC_LOAD_TEST_RUN_EPOCH_MILLIS = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $info = New-ProcessInfo -FilePath $Executable -WorkingDirectory $WorkingDirectory -Environment $environment -Arguments @(
        'run', '--quiet', '--insecure-skip-tls-verify', '--summary-export', $SummaryPath, $ScriptPath
    )
    foreach ($name in $script:ProxyEnvironmentVariables) { $null = $info.Environment.Remove($name) }
    $info.Environment['NO_PROXY'] = '*'
    $info.Environment['no_proxy'] = '*'
    return $info
}

function Assert-DirectHttpsReachable {
    param([Parameter(Mandatory)][string]$BaseUrl)
    $uri = $null
    Assert-Condition ([System.Uri]::TryCreate($BaseUrl, [System.UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq 'https') 'direct HTTPS preflight target is invalid'
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $handler.ServerCertificateCustomValidationCallback = [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    try {
        foreach ($path in @('/health', '/ready')) {
            $response = $client.GetAsync(($BaseUrl.TrimEnd('/') + $path), [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            try {
                Assert-Condition ([int]$response.StatusCode -eq 200) 'direct HTTPS preflight returned a non-success response'
            } finally {
                $response.Dispose()
            }
        }
    } catch {
        throw 'direct HTTPS endpoint is not reachable from the load client'
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
}

function ConvertTo-ShellLiteral {
    param([string]$Value)
    $quote = [string][char]39
    $replacement = $quote + '"' + $quote + '"' + $quote
    return $quote + $Value.Replace($quote, $replacement) + $quote
}

function Invoke-RootCommand {
    param([string]$Wrapper, [string]$Command, [AllowNull()][string]$InputText = $null)
    try {
        $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $info = New-ProcessInfo -FilePath $pwsh -Arguments @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Wrapper, $Command
        )
        $info.RedirectStandardInput = $true
        $handle = Start-CapturedProcess $info
        if ($null -ne $InputText) { $handle.Process.StandardInput.Write($InputText) }
        $handle.Process.StandardInput.Close()
        $result = Complete-CapturedProcess -Handle $handle -TimeoutMilliseconds 180000 -TerminateOnTimeout
    } catch {
        throw 'root wrapper invocation failed'
    }
    if ($result.ExitCode -ne 0) {
        $diagnostic = $result.Stdout + "`n" + $result.Stderr
        if ($diagnostic -match '(?i)timed out') { throw 'remote access timed out' }
        if ($diagnostic -match '(?i)permission denied|authentication failed|publickey') { throw 'remote access authentication was rejected' }
        if ($diagnostic -match '(?i)host key|known_hosts|verification failed') { throw 'remote host identity verification failed' }
        if ($result.ExitCode -eq 255) { throw 'remote SSH connection failed' }
        throw 'remote test command failed'
    }
    return $result.Stdout.Trim()
}

function Start-RemoteCapacityLock {
    param([string]$Wrapper, [string]$RemoteRoot, [string]$RemoteRun)
    $null = Assert-RemoteRoot $RemoteRoot
    $prefix = $RemoteRoot.TrimEnd('/') + '/windows-'
    Assert-Condition ($RemoteRun.StartsWith($prefix, [System.StringComparison]::Ordinal)) 'remote lock run path escaped its dedicated root'
    $suffix = $RemoteRun.Substring($prefix.Length)
    Assert-Condition ($suffix -cmatch '^\d{8}T\d{6}Z-[a-f0-9]{8}$') 'remote lock run path is invalid'
    $leaseId = [Guid]::NewGuid().ToString('N')
    $ready = '/run/lock/kunpeng-capacity/control/ready'
    $scriptText = @'
set -euo pipefail
root=__ROOT__
run=__RUN__
lease=__LEASE__
lock_directory='/run/lock/kunpeng-capacity'
lock="$lock_directory/global.lock"
control="$lock_directory/control"
ready="$control/ready"
commands="$control/commands"
test -d "$root"
test ! -L "$root"
test "$(stat -c %u -- "$root")" = 0
test "$(stat -c %a -- "$root")" = 700
test -d "$run"
test ! -L "$run"
test "$(stat -c %u -- "$run")" = 0
test "$(stat -c %a -- "$run")" = 700
if ! mkdir -m 0700 -- "$lock_directory" 2>/dev/null; then
  test -e "$lock_directory"
fi
test -d "$lock_directory"
test ! -L "$lock_directory"
test "$(stat -c %u -- "$lock_directory")" = 0
test "$(stat -c %a -- "$lock_directory")" = 700
umask 077
if test -e "$lock"; then
  test -f "$lock"
  test ! -L "$lock"
  test "$(stat -c %u -- "$lock")" = 0
  test "$(stat -c %a -- "$lock")" = 600
  test "$(stat -c %h -- "$lock")" = 1
fi
exec 9>>"$lock"
chmod 0600 -- "$lock"
test -f "$lock"
test ! -L "$lock"
test "$(stat -c %u -- "$lock")" = 0
test "$(stat -c %a -- "$lock")" = 600
test "$(stat -c %h -- "$lock")" = 1
flock -n 9 || exit 73
if ! mkdir -m 0700 -- "$control" 2>/dev/null; then
  test -e "$control"
fi
test -d "$control"
test ! -L "$control"
test "$(stat -c %u -- "$control")" = 0
test "$(stat -c %a -- "$control")" = 700
temporary="${ready}.partial"
if test -e "$temporary"; then
  test -f "$temporary"
  test ! -L "$temporary"
  test "$(stat -c %u -- "$temporary")" = 0
  test "$(stat -c %a -- "$temporary")" = 600
  test "$(stat -c %h -- "$temporary")" = 1
  rm -f -- "$temporary"
fi
if test -e "$ready"; then
  test -f "$ready"
  test ! -L "$ready"
  test "$(stat -c %u -- "$ready")" = 0
  test "$(stat -c %a -- "$ready")" = 600
  test "$(stat -c %h -- "$ready")" = 1
  rm -f -- "$ready"
fi
if test -e "$commands"; then
  test -p "$commands"
  test ! -L "$commands"
  test "$(stat -c %u -- "$commands")" = 0
  test "$(stat -c %a -- "$commands")" = 600
  test "$(stat -c %h -- "$commands")" = 1
  rm -f -- "$commands"
fi
test "$(find "$control" -mindepth 1 -maxdepth 1 -printf x | wc -c)" = 0
mkfifo -m 0600 -- "$commands"
trap 'rm -f -- "$temporary" "$ready" "$commands"' EXIT
lock_pid="$$"
lock_starttime="$(awk '{print $22}' "/proc/$lock_pid/stat")"
[[ "$lock_pid" =~ ^[1-9][0-9]*$ ]]
[[ "$lock_starttime" =~ ^[1-9][0-9]*$ ]]
printf 'remote_capacity_lock=acquired\nlease_id=%s\nlock_pid=%s\nlock_starttime=%s\n' \
  "$lease" "$lock_pid" "$lock_starttime" > "$temporary"
chmod 0600 -- "$temporary"
mv -f -- "$temporary" "$ready"
trap 'exit 0' HUP INT TERM
while :; do
  request_message=''
  IFS= read -r request_message < "$commands" || continue
  request_lease="${request_message%%:*}"
  request_id="${request_message#*:}"
  [[ "$request_lease" =~ ^[a-f0-9]{32}$ ]]
  [[ "$request_id" != "$request_message" ]]
  if test "$request_lease" != "$lease"; then
    continue
  fi
  if test "$request_id" = release; then
    exit 0
  fi
  [[ "$request_id" =~ ^[a-f0-9]{32}$ ]]
  request="$run/remote-lock-request-$request_id.sh"
  stdout="$run/remote-lock-response-$request_id.stdout"
  stderr="$run/remote-lock-response-$request_id.stderr"
  status="$run/remote-lock-response-$request_id.status"
  test -f "$request"
  test ! -L "$request"
  test "$(stat -c %u -- "$request")" = 0
  test "$(stat -c %a -- "$request")" = 700
  test "$(stat -c %h -- "$request")" = 1
  test "$(stat -c %s -- "$request")" -le 1048576
  test ! -e "$stdout"
  test ! -e "$stderr"
  test ! -e "$status"
  stdout_temporary="${stdout}.partial"
  stderr_temporary="${stderr}.partial"
  status_temporary="${status}.partial"
  rm -f -- "$stdout_temporary" "$stderr_temporary" "$status_temporary"
  set +e
  timeout --signal=TERM --kill-after=5s 120s bash "$request" > "$stdout_temporary" 2> "$stderr_temporary"
  exit_code=$?
  set -e
  rm -f -- "$request"
  if test "$(stat -c %s -- "$stdout_temporary")" -gt 1048576 ||
      test "$(stat -c %s -- "$stderr_temporary")" -gt 1048576; then
    : > "$stdout_temporary"
    : > "$stderr_temporary"
    exit_code=74
  fi
  chmod 0600 -- "$stdout_temporary" "$stderr_temporary"
  mv -- "$stdout_temporary" "$stdout"
  mv -- "$stderr_temporary" "$stderr"
  printf '%s\n' "$exit_code" > "$status_temporary"
  chmod 0600 -- "$status_temporary"
  mv -- "$status_temporary" "$status"
done
'@
    $scriptText = $scriptText.Replace('__ROOT__', (ConvertTo-ShellLiteral $RemoteRoot)).Replace('__RUN__', (ConvertTo-ShellLiteral $RemoteRun)).Replace('__LEASE__', (ConvertTo-ShellLiteral $leaseId))
    $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $info = New-ProcessInfo -FilePath $pwsh -Arguments @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Wrapper,
        ('bash -c ' + (ConvertTo-ShellLiteral $scriptText))
    )
    $handle = Start-CapturedProcess $info
    try {
        foreach ($attempt in 1..20) {
            if ($handle.Process.HasExited) { throw 'remote capacity lock is already held' }
            try {
                $probeCommand = @'
set -eu
ready=__READY__
test -f "$ready"
test ! -L "$ready"
test "$(stat -c %u -- "$ready")" = 0
test "$(stat -c %a -- "$ready")" = 600
mapfile -t rows < "$ready"
test "${#rows[@]}" = 4
test "${rows[0]}" = 'remote_capacity_lock=acquired'
test "${rows[1]}" = __LEASE_ROW__
[[ "${rows[2]}" =~ ^lock_pid=[1-9][0-9]*$ ]]
[[ "${rows[3]}" =~ ^lock_starttime=[1-9][0-9]*$ ]]
commands="${ready%/ready}/commands"
test -p "$commands"
test ! -L "$commands"
test "$(stat -c %u -- "$commands")" = 0
test "$(stat -c %a -- "$commands")" = 600
printf '%s' remote_capacity_lock=acquired
'@
                $probeCommand = $probeCommand.Replace('__READY__', (ConvertTo-ShellLiteral $ready)).Replace('__LEASE_ROW__', (ConvertTo-ShellLiteral "lease_id=$leaseId"))
                $probe = Invoke-RootCommand -Wrapper $Wrapper -Command $probeCommand
                if ($probe -eq 'remote_capacity_lock=acquired') {
                    Assert-Condition (-not $handle.Process.HasExited) 'remote capacity lock ended during acquisition'
                    $handle | Add-Member -NotePropertyName LeaseId -NotePropertyValue $leaseId
                    return $handle
                }
            } catch {}
            Start-Sleep -Milliseconds 250
        }
        throw 'remote capacity lock readiness was not confirmed'
    } catch {
        $null = Stop-CapturedProcessSafe $handle
        throw
    }
}

function Assert-RemoteCapacityLockAlive {
    param([AllowNull()][object]$Handle)
    Assert-Condition ($null -ne $Handle -and -not $Handle.Process.HasExited) 'remote capacity lock was lost'
}

function Invoke-RootCommandWithCapacityLock {
    param(
        [string]$Wrapper,
        [object]$Handle,
        [string]$RemoteRoot,
        [string]$RemoteRun,
        [string]$Command
    )
    $null = Assert-RemoteRoot $RemoteRoot
    $prefix = $RemoteRoot.TrimEnd('/') + '/windows-'
    Assert-Condition ($RemoteRun.StartsWith($prefix, [System.StringComparison]::Ordinal)) 'remote locked command path escaped its dedicated root'
    $suffix = $RemoteRun.Substring($prefix.Length)
    Assert-Condition ($suffix -cmatch '^\d{8}T\d{6}Z-[a-f0-9]{8}$') 'remote locked command run path is invalid'
    Assert-RemoteCapacityLockAlive $Handle
    $leaseId = [string]$Handle.LeaseId
    Assert-Condition ($leaseId -cmatch '^[a-f0-9]{32}$') 'remote capacity lock lease identity is invalid'
    $requestId = [Guid]::NewGuid().ToString('N')
    $request = "$RemoteRun/remote-lock-request-$requestId.sh"
    $stdout = "$RemoteRun/remote-lock-response-$requestId.stdout"
    $stderr = "$RemoteRun/remote-lock-response-$requestId.stderr"
    $status = "$RemoteRun/remote-lock-response-$requestId.status"
    $bytes = $script:Utf8NoBom.GetBytes($Command + "`n")
    Assert-Condition ($bytes.Length -gt 0 -and $bytes.Length -le 1048576) 'remote locked command exceeded its size guard'
    $sha = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $payload = [Convert]::ToBase64String($bytes)
    $requestLiteral = ConvertTo-ShellLiteral $request
    $expectedLiteral = ConvertTo-ShellLiteral $sha
    $cleanupCommand = 'rm -f -- {0} {1} {2} {3} {1}.partial {2}.partial {3}.partial' -f (
        $requestLiteral), (ConvertTo-ShellLiteral $stdout), (ConvertTo-ShellLiteral $stderr), (ConvertTo-ShellLiteral $status)
    try {
        $uploadCommand = @'
set -eu
umask 077
request=__REQUEST__
test ! -e "$request"
temporary="${request}.partial"
trap 'rm -f -- "$temporary"' EXIT
base64 -d > "$temporary"
test "$(sha256sum "$temporary" | awk '{print $1}')" = __EXPECTED__
chmod 0700 -- "$temporary"
mv -- "$temporary" "$request"
trap - EXIT
'@
        $uploadCommand = $uploadCommand.Replace('__REQUEST__', $requestLiteral).Replace('__EXPECTED__', $expectedLiteral)
        $null = Invoke-RootCommand -Wrapper $Wrapper -Command $uploadCommand -InputText $payload
        Assert-RemoteCapacityLockAlive $Handle
        $submitCommand = @'
set -euo pipefail
run=__RUN__
lease=__LEASE__
request_id=__REQUEST_ID__
request=__REQUEST__
control='/run/lock/kunpeng-capacity/control'
ready="$control/ready"
commands="$control/commands"
test -d "$run"
test ! -L "$run"
test "$(stat -c %u -- "$run")" = 0
test "$(stat -c %a -- "$run")" = 700
test -f "$request"
test ! -L "$request"
test "$(stat -c %u -- "$request")" = 0
test "$(stat -c %a -- "$request")" = 700
test -f "$ready"
test ! -L "$ready"
mapfile -t rows < "$ready"
test "${#rows[@]}" = 4
test "${rows[0]}" = 'remote_capacity_lock=acquired'
test "${rows[1]}" = "lease_id=$lease"
test -p "$commands"
test ! -L "$commands"
test "$(stat -c %u -- "$commands")" = 0
test "$(stat -c %a -- "$commands")" = 600
timeout 5 bash -c 'printf "%s:%s\n" "$1" "$2" > "$3"' _ "$lease" "$request_id" "$commands"
'@
        $submitCommand = $submitCommand.Replace('__RUN__', (ConvertTo-ShellLiteral $RemoteRun)).Replace('__LEASE__', (ConvertTo-ShellLiteral $leaseId)).Replace('__REQUEST_ID__', (ConvertTo-ShellLiteral $requestId)).Replace('__REQUEST__', $requestLiteral)
        $null = Invoke-RootCommand -Wrapper $Wrapper -Command $submitCommand
        $pollCommand = @'
set -euo pipefail
ready=__READY__
lease=__LEASE__
stdout=__STDOUT__
stderr=__STDERR__
status=__STATUS__
for _ in $(seq 1 520); do
  test -f "$ready"
  mapfile -t rows < "$ready"
  test "${#rows[@]}" = 4
  test "${rows[0]}" = 'remote_capacity_lock=acquired'
  test "${rows[1]}" = "lease_id=$lease"
  pid="${rows[2]#lock_pid=}"
  expected_starttime="${rows[3]#lock_starttime=}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]]
  [[ "$expected_starttime" =~ ^[1-9][0-9]*$ ]]
  kill -0 "$pid" 2>/dev/null
  test "$(awk '{print $22}' "/proc/$pid/stat")" = "$expected_starttime"
  if test -f "$status"; then break; fi
  sleep 0.25
done
test -f "$status"
test -f "$ready"
mapfile -t rows < "$ready"
test "${#rows[@]}" = 4
test "${rows[0]}" = 'remote_capacity_lock=acquired'
test "${rows[1]}" = "lease_id=$lease"
pid="${rows[2]#lock_pid=}"
expected_starttime="${rows[3]#lock_starttime=}"
[[ "$pid" =~ ^[1-9][0-9]*$ ]]
[[ "$expected_starttime" =~ ^[1-9][0-9]*$ ]]
kill -0 "$pid" 2>/dev/null
test "$(awk '{print $22}' "/proc/$pid/stat")" = "$expected_starttime"
test ! -L "$status"
test "$(stat -c %u -- "$status")" = 0
test "$(stat -c %a -- "$status")" = 600
test "$(stat -c %s -- "$status")" -le 4
exit_code="$(cat "$status")"
[[ "$exit_code" =~ ^([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])$ ]]
for output in "$stdout" "$stderr"; do
  test -f "$output"
  test ! -L "$output"
  test "$(stat -c %u -- "$output")" = 0
  test "$(stat -c %a -- "$output")" = 600
  test "$(stat -c %s -- "$output")" -le 1048576
done
printf 'capacity_lock_command_exit=%s\n' "$exit_code"
cat "$stdout"
'@
        $pollCommand = $pollCommand.Replace('__READY__', (ConvertTo-ShellLiteral '/run/lock/kunpeng-capacity/control/ready')).Replace('__LEASE__', (ConvertTo-ShellLiteral $leaseId)).Replace('__STDOUT__', (ConvertTo-ShellLiteral $stdout)).Replace('__STDERR__', (ConvertTo-ShellLiteral $stderr)).Replace('__STATUS__', (ConvertTo-ShellLiteral $status))
        $result = Invoke-RootCommand -Wrapper $Wrapper -Command $pollCommand
        Assert-RemoteCapacityLockAlive $Handle
        $lines = $result -split '\r?\n', 2
        Assert-Condition ($lines.Count -ge 1 -and $lines[0] -match '^capacity_lock_command_exit=([0-9]{1,3})$') 'remote locked command returned an unexpected response'
        Assert-Condition ([int]$Matches[1] -eq 0) 'remote locked command failed'
        return $(if ($lines.Count -eq 2) { $lines[1].Trim() } else { '' })
    } finally {
        try { $null = Invoke-RootCommand -Wrapper $Wrapper -Command $cleanupCommand } catch {}
    }
}

function Stop-RemoteCapacityLock {
    param([AllowNull()][object]$Handle, [string]$Wrapper, [string]$RemoteRun)
    if ($null -eq $Handle) { return $true }
    $leaseId = [string]$Handle.LeaseId
    if ($leaseId -cnotmatch '^[a-f0-9]{32}$') { return $false }
    $guardianExitedCleanly = $false
    try {
        $ready = '/run/lock/kunpeng-capacity/control/ready'
        $releaseCommand = @'
set -euo pipefail
ready=__READY__
lease=__LEASE__
if test ! -e "$ready"; then
  printf '%s' remote_capacity_lock=released
  exit 0
fi
test -f "$ready"
test ! -L "$ready"
test "$(stat -c %u -- "$ready")" = 0
test "$(stat -c %a -- "$ready")" = 600
mapfile -t rows < "$ready"
test "${#rows[@]}" = 4
test "${rows[0]}" = 'remote_capacity_lock=acquired'
test "${rows[1]}" = "lease_id=$lease"
pid="${rows[2]#lock_pid=}"
starttime="${rows[3]#lock_starttime=}"
[[ "$pid" =~ ^[1-9][0-9]*$ ]]
[[ "$starttime" =~ ^[1-9][0-9]*$ ]]
commands="${ready%/ready}/commands"
test -p "$commands"
test ! -L "$commands"
test "$(stat -c %u -- "$commands")" = 0
test "$(stat -c %a -- "$commands")" = 600
timeout 5 bash -c 'printf "%s:release\n" "$1" > "$2"' _ "$lease" "$commands"
for _ in $(seq 1 40); do
  if test ! -e "$ready" && test ! -e "$commands"; then
    printf '%s' remote_capacity_lock=released
    exit 0
  fi
  sleep 0.25
done
exit 75
'@
        $releaseCommand = $releaseCommand.Replace('__READY__', (ConvertTo-ShellLiteral $ready)).Replace('__LEASE__', (ConvertTo-ShellLiteral $leaseId))
        $release = Invoke-RootCommand -Wrapper $Wrapper -Command $releaseCommand
        $result = Complete-CapturedProcess -Handle $Handle -TimeoutMilliseconds 15000 -TerminateOnTimeout
        if ($release -eq 'remote_capacity_lock=released' -and $result.ExitCode -eq 0) {
            $guardianExitedCleanly = $true
        }
    } catch {}

    # A guardian killed while a bounded request is running may leave the
    # timeout/request process holding fd9 until its 120-second inner deadline.
    # Drain the local SSH tree, keep the stable control metadata, and wait for
    # the actual flock to become acquirable. A different lease means another
    # runner has taken ownership and must not be interrupted.
    if (-not $guardianExitedCleanly) {
        $null = Stop-CapturedProcessSafe $Handle
    }
    $waitCommand = @'
set -euo pipefail
lock='/run/lock/kunpeng-capacity/global.lock'
ready='/run/lock/kunpeng-capacity/control/ready'
lease=__LEASE__
test -f "$lock"
test ! -L "$lock"
test "$(stat -c %u -- "$lock")" = 0
test "$(stat -c %a -- "$lock")" = 600
test "$(stat -c %h -- "$lock")" = 1
for _ in $(seq 1 520); do
  if test -e "$ready"; then
    test -f "$ready"
    test ! -L "$ready"
    mapfile -t rows < "$ready"
    test "${#rows[@]}" = 4
    test "${rows[0]}" = 'remote_capacity_lock=acquired'
    test "${rows[1]}" = "lease_id=$lease"
  fi
  if flock -n "$lock" -c true; then
    printf '%s' remote_capacity_lock=released
    exit 0
  fi
  sleep 0.25
done
exit 75
'@
    $waitCommand = $waitCommand.Replace('__LEASE__', (ConvertTo-ShellLiteral $leaseId))
    try {
        return (Invoke-RootCommand -Wrapper $Wrapper -Command $waitCommand) -eq 'remote_capacity_lock=released'
    } catch {
        return $false
    }
}

function Resolve-DirectHostFromRootConnection {
    param([string]$Wrapper)
    $command = @'
set -eu
python3 - <<'PY'
import ipaddress
import os

parts = os.environ.get("SSH_CONNECTION", "").split()
if len(parts) != 4:
    raise SystemExit(2)
for value in (parts[1], parts[3]):
    if not value.isdecimal() or not 1 <= int(value) <= 65535:
        raise SystemExit(2)
ipaddress.ip_address(parts[0])
server = ipaddress.ip_address(parts[2])
if server.is_loopback or server.is_unspecified:
    raise SystemExit(2)
print(server.compressed)
PY
'@
    $value = Invoke-RootCommand -Wrapper $Wrapper -Command $command
    Assert-DirectHost $value
    return $value
}

function Send-RemoteFile {
    param([string]$Wrapper, [string]$LocalPath, [string]$RemotePath)
    $bytes = [System.IO.File]::ReadAllBytes($LocalPath)
    $sha = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $payload = [Convert]::ToBase64String($bytes)
    $remote = ConvertTo-ShellLiteral $RemotePath
    $expected = ConvertTo-ShellLiteral $sha
    $command = @'
set -eu
umask 077
remote=__REMOTE__
tmp="${remote}.partial"
trap 'rm -f -- "$tmp"' EXIT
base64 -d > "$tmp"
test "$(sha256sum "$tmp" | awk '{print $1}')" = __EXPECTED__
chmod 0700 "$tmp"
mv -- "$tmp" "$remote"
trap - EXIT
'@
    $command = $command.Replace('__REMOTE__', $remote).Replace('__EXPECTED__', $expected)
    $null = Invoke-RootCommand -Wrapper $Wrapper -Command $command -InputText $payload
}

function Receive-RemoteFile {
    param([string]$Wrapper, [string]$RemotePath, [string]$LocalPath, [int]$MaximumBytes = 16777216)
    $remote = ConvertTo-ShellLiteral $RemotePath
    $encoded = Invoke-RootCommand -Wrapper $Wrapper -Command "set -eu; test -f $remote; base64 -w0 -- $remote"
    Assert-Condition ($encoded.Length -le [Math]::Ceiling($MaximumBytes / 3.0) * 4 + 16) 'remote artifact exceeded its size guard'
    try { $bytes = [Convert]::FromBase64String($encoded) } catch { throw 'remote artifact was not valid base64' }
    Assert-Condition ($bytes.Length -le $MaximumBytes) 'remote artifact exceeded its decoded size guard'
    Write-PrivateBytes -Path $LocalPath -Bytes $bytes
}

function Parse-ControlOutput {
    param([string]$Text)
    $values = @{}
    foreach ($line in ($Text -split '\r?\n')) {
        if (-not $line) { continue }
        Assert-Condition ($line -match '^([a-z0-9_]+)=([A-Za-z0-9._-]+)$') 'direct control returned an unexpected response'
        $values[$Matches[1]] = $Matches[2]
    }
    return $values
}

function Assert-DirectCleanupOutput {
    param([hashtable]$Values, [switch]$RequireRestorationEvidence)
    Assert-Condition ($Values.direct_control -eq 'clean') 'temporary direct HTTPS cleanup was not confirmed'
    if ($RequireRestorationEvidence -or $Values.Count -gt 1) {
        Assert-Condition (
            $Values.service_restored -eq 'true' -and
            $Values.production_active_before -eq 'true' -and
            $Values.production_active_after -eq 'true' -and
            $Values.production_unchanged -eq 'true' -and
            $Values.caddy_test_port_reference_count -eq '0'
        ) 'temporary direct HTTPS restoration evidence was incomplete'
    }
}

function Get-PendingFixtureRegisterCommand {
    param([string]$RemoteRoot, [string]$Service, [string]$FixtureId)
    $null = Assert-RemoteRoot $RemoteRoot
    Assert-TestServiceName $Service
    Assert-FixtureId $FixtureId
    $scriptText = @'
set -euo pipefail
root=__ROOT__
service=__SERVICE__
fixture=__FIXTURE__
pending="$root/pending"
if test ! -e "$pending"; then
  install -d -m 0700 -o root -g root -- "$pending"
fi
test -d "$pending"
test ! -L "$pending"
test "$(stat -c %u -- "$pending")" = 0
test "$(stat -c %a -- "$pending")" = 700
record="$pending/$fixture.pending"
test ! -e "$record"
fingerprint="$(python3 - "$service" <<'PY'
import hashlib
import subprocess
import sys

service = sys.argv[1]
pid_text = subprocess.check_output(
    ["systemctl", "show", "-p", "MainPID", "--value", service],
    text=True,
).strip()
if not pid_text.isdecimal() or int(pid_text) <= 0:
    raise SystemExit(1)
with open(f"/proc/{pid_text}/environ", "rb") as source:
    entries = source.read().split(b"\0")
def environment_value(name: bytes) -> bytes:
    prefix = name + b"="
    return next((entry.split(b"=", 1)[1] for entry in entries if entry.startswith(prefix)), b"")
database_url = environment_value(b"KUNPENG_SYNC_DATABASE_URL")
token_hmac_key = environment_value(b"KUNPENG_SYNC_TOKEN_HMAC_KEY")
if not database_url or not token_hmac_key:
    raise SystemExit(1)
digest = hashlib.sha256(database_url + b"\0" + token_hmac_key).hexdigest()
print(digest)
PY
)"
[[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]]
umask 077
temporary="$(mktemp --tmpdir="$pending" ".new-$fixture.XXXXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
printf 'version=1\nservice=%s\nfixture_id=%s\ntarget_fingerprint=%s\n' \
  "$service" "$fixture" "$fingerprint" > "$temporary"
chmod 0600 -- "$temporary"
python3 - "$temporary" <<'PY'
import os
import sys

flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(sys.argv[1], flags)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
ln -- "$temporary" "$record"
python3 - "$pending" "$root" <<'PY'
import os
import sys

flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
for path in sys.argv[1:]:
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
rm -f -- "$temporary"
python3 - "$pending" <<'PY'
import os
import sys

flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(sys.argv[1], flags)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
trap - EXIT
test -f "$record"
test ! -L "$record"
test "$(stat -c %u -- "$record")" = 0
test "$(stat -c %a -- "$record")" = 600
printf 'fixture_recovery=pending\ntarget_fingerprint=%s\n' "$fingerprint"
'@
    $scriptText = $scriptText.Replace('__ROOT__', (ConvertTo-ShellLiteral $RemoteRoot)).Replace('__SERVICE__', (ConvertTo-ShellLiteral $Service)).Replace('__FIXTURE__', (ConvertTo-ShellLiteral $FixtureId))
    return 'bash -c ' + (ConvertTo-ShellLiteral $scriptText)
}

function Get-PendingFixtureRecoveryCommand {
    param([string]$RemoteRoot, [string]$RemoteSeeder, [string]$Service)
    $null = Assert-RemoteRoot $RemoteRoot
    Assert-TestServiceName $Service
    $scriptText = @'
set -euo pipefail
root=__ROOT__
seeder=__SEEDER__
service=__SERVICE__
pending="$root/pending"
if test ! -e "$pending"; then
  install -d -m 0700 -o root -g root -- "$pending"
fi
test -d "$pending"
test ! -L "$pending"
test "$(stat -c %u -- "$pending")" = 0
test "$(stat -c %a -- "$pending")" = 700
test -f "$seeder"
test ! -L "$seeder"
count=0
shopt -s nullglob dotglob
temporaries=("$pending"/.new-*)
for temporary in "${temporaries[@]}"; do
  test -f "$temporary"
  test ! -L "$temporary"
  test "$(stat -c %u -- "$temporary")" = 0
  test "$(stat -c %a -- "$temporary")" = 600
  name="${temporary##*/}"
  [[ "$name" =~ ^\.new-(w[a-f0-9]{11})\.[A-Za-z0-9]{8}$ ]]
  fixture="${BASH_REMATCH[1]}"
  links="$(stat -c %h -- "$temporary")"
  record="$pending/$fixture.pending"
  if test "$links" = 2; then
    test -f "$record"
    test ! -L "$record"
    test "$(stat -c %i -- "$temporary")" = "$(stat -c %i -- "$record")"
  else
    test "$links" = 1
    test ! -e "$record"
  fi
  rm -f -- "$temporary"
  test ! -e "$temporary"
done
records=("$pending"/*)
for record in "${records[@]}"; do
  test -f "$record"
  test ! -L "$record"
  test "$(stat -c %u -- "$record")" = 0
  test "$(stat -c %a -- "$record")" = 600
  test "$(stat -c %h -- "$record")" = 1
  name="${record##*/}"
  [[ "$name" =~ ^w[a-f0-9]{11}\.pending$ ]]
  fixture="${name%.pending}"
  mapfile -t rows < "$record"
  test "${#rows[@]}" = 4
  test "${rows[0]}" = 'version=1'
  test "${rows[1]}" = "service=$service"
  test "${rows[2]}" = "fixture_id=$fixture"
  expected_fingerprint="${rows[3]#target_fingerprint=}"
  [[ "$expected_fingerprint" =~ ^[a-f0-9]{64}$ ]]
  test "${rows[3]}" = "target_fingerprint=$expected_fingerprint"
  cleaned=false
  for attempt in 1 2 3; do
    if python3 "$seeder" cleanup --service "$service" --fixture-id "$fixture" \
        --expected-target-fingerprint "$expected_fingerprint" --allow-absent >/dev/null; then
      cleaned=true
      break
    fi
    sleep "$attempt"
  done
  test "$cleaned" = true
  rm -f -- "$record"
  python3 - "$pending" <<'PY'
import os
import sys

flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(sys.argv[1], flags)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  test ! -e "$record"
  count=$((count + 1))
done
printf 'recovered_pending_fixtures=%s\n' "$count"
'@
    $scriptText = $scriptText.Replace('__ROOT__', (ConvertTo-ShellLiteral $RemoteRoot)).Replace('__SEEDER__', (ConvertTo-ShellLiteral $RemoteSeeder)).Replace('__SERVICE__', (ConvertTo-ShellLiteral $Service))
    return 'bash -c ' + (ConvertTo-ShellLiteral $scriptText)
}

function Get-RemoteRunCleanupCommand {
    param([string]$RemoteRoot, [string]$RemoteRun)
    $null = Assert-RemoteRoot $RemoteRoot
    $prefix = $RemoteRoot.TrimEnd('/') + '/windows-'
    Assert-Condition ($RemoteRun.StartsWith($prefix, [System.StringComparison]::Ordinal)) 'remote run cleanup target escaped its dedicated root'
    $suffix = $RemoteRun.Substring($prefix.Length)
    Assert-Condition ($suffix -cmatch '^\d{8}T\d{6}Z-[a-f0-9]{8}$') 'remote run cleanup target is invalid'
    $rootLiteral = ConvertTo-ShellLiteral $RemoteRoot
    $runLiteral = ConvertTo-ShellLiteral $RemoteRun
    return ('set -eu; root={0}; run={1}; quarantine="${{run}}.cleanup"; case "$run" in "$root"/windows-*) ;; *) exit 50;; esac; case "$quarantine" in "$root"/windows-*.cleanup) ;; *) exit 51;; esac; test "$run" != /; test "$quarantine" != /; if test -e "$run"; then test -d "$run"; test ! -L "$run"; test ! -e "$quarantine"; mv -T -- "$run" "$quarantine"; fi; test ! -e "$run"; if test -e "$quarantine"; then test -d "$quarantine"; test ! -L "$quarantine"; rm -rf -- "$quarantine"; fi; test ! -e "$run"; test ! -e "$quarantine"' -f $rootLiteral, $runLiteral)
}

function Stop-RemoteCapacityMonitor {
    param(
        [string]$Wrapper,
        [AllowEmptyString()][string]$IdentityPath,
        [string]$ExpectedMonitorPath,
        [string]$ExpectedOutputPath,
        [switch]$RequireIdentity
    )
    if ([string]::IsNullOrWhiteSpace($IdentityPath)) { return $true }
    $command = @'
set -euo pipefail
identity=__IDENTITY__
expected_monitor=__MONITOR__
expected_output=__OUTPUT__
guard="${identity}.guard"
cancel="${identity}.cancel"
ensure_cancel() {
  if test -e "$cancel"; then
    test -f "$cancel"
    test ! -L "$cancel"
    mapfile -t cancel_rows < "$cancel"
    test "${#cancel_rows[@]}" = 3
    test "${cancel_rows[0]}" = 'remote_capacity_monitor_launch=cancelled'
    test "${cancel_rows[1]}" = "monitor=$expected_monitor"
    test "${cancel_rows[2]}" = "output=$expected_output"
  else
    cancel_tmp="${cancel}.tmp.$$"
    test ! -e "$cancel_tmp"
    test ! -L "$cancel_tmp"
    trap 'rm -f -- "$cancel_tmp"' EXIT
    umask 077
    printf 'remote_capacity_monitor_launch=cancelled\nmonitor=%s\noutput=%s\n' "$expected_monitor" "$expected_output" > "$cancel_tmp"
    chmod 0600 "$cancel_tmp"
    mv -T -- "$cancel_tmp" "$cancel"
    trap - EXIT
  fi
  test -f "$cancel"
  test ! -L "$cancel"
  test "$(stat -c %u -- "$cancel")" = 0
  test "$(stat -c %a -- "$cancel")" = 600
  test "$(stat -c %h -- "$cancel")" = 1
  test "$(stat -c %s -- "$cancel")" -le 4096
}
ensure_cancel
if test ! -e "$guard"; then
  test ! -e "$identity"
  test __REQUIRE_IDENTITY__ = 0
  printf '%s' remote_capacity_monitor=stopped
  exit 0
fi
test -f "$guard"
test ! -L "$guard"
test "$(stat -c %u -- "$guard")" = 0
test "$(stat -c %a -- "$guard")" = 600
test "$(stat -c %h -- "$guard")" = 1
test "$(stat -c %s -- "$guard")" -le 4096
exec 9<>"$guard"
flock -w 15 -x 9
mapfile -t guard_rows <&9
test "${#guard_rows[@]}" = 3
test "${guard_rows[0]}" = 'remote_capacity_monitor_launch=registered'
test "${guard_rows[1]}" = "monitor=$expected_monitor"
test "${guard_rows[2]}" = "output=$expected_output"
ensure_cancel
if test ! -e "$identity"; then
  flock -u 9
  test __REQUIRE_IDENTITY__ = 0
  printf '%s' remote_capacity_monitor=stopped
  exit 0
fi
test -f "$identity"
test ! -L "$identity"
test "$(stat -c %u -- "$identity")" = 0
test "$(stat -c %a -- "$identity")" = 600
test "$(stat -c %h -- "$identity")" = 1
test "$(stat -c %s -- "$identity")" -le 4096
mapfile -t rows < "$identity"
test "${#rows[@]}" = 5
test "${rows[0]}" = 'remote_capacity_monitor=running'
pid="${rows[1]#pid=}"
starttime="${rows[2]#starttime=}"
test "${rows[3]}" = "monitor=$expected_monitor"
test "${rows[4]}" = "output=$expected_output"
[[ "$pid" =~ ^[1-9][0-9]*$ ]]
[[ "$starttime" =~ ^[1-9][0-9]*$ ]]
same_process() {
  test -r "/proc/$pid/stat" || return 1
  test "$(awk '{print $22}' "/proc/$pid/stat")" = "$starttime"
}
if same_process; then
  python3 - "$pid" "$expected_monitor" "$expected_output" <<'PY'
import sys
pid, expected_monitor, expected_output = sys.argv[1:]
with open(f"/proc/{pid}/cmdline", "rb") as source:
    arguments = [item.decode() for item in source.read().split(b"\0") if item]
if expected_monitor not in arguments or expected_output not in arguments:
    raise SystemExit(1)
PY
  kill -TERM "$pid"
  for _ in $(seq 1 40); do
    same_process || break
    sleep 0.25
  done
  if same_process; then
    kill -KILL "$pid"
    for _ in $(seq 1 20); do
      same_process || break
      sleep 0.25
    done
  fi
  same_process && exit 75
fi
rm -f -- "$identity"
test ! -e "$identity"
flock -u 9
printf '%s' remote_capacity_monitor=stopped
'@
    $command = $command.Replace('__IDENTITY__', (ConvertTo-ShellLiteral $IdentityPath)).Replace('__MONITOR__', (ConvertTo-ShellLiteral $ExpectedMonitorPath)).Replace('__OUTPUT__', (ConvertTo-ShellLiteral $ExpectedOutputPath)).Replace('__REQUIRE_IDENTITY__', $(if ($RequireIdentity) { '1' } else { '0' }))
    try {
        return (Invoke-RootCommand -Wrapper $Wrapper -Command $command) -eq 'remote_capacity_monitor=stopped'
    } catch {
        return $false
    }
}

function Get-SanitizedDiagnostic {
    param([string]$Text, [string[]]$SensitiveValues)
    $safe = $Text
    foreach ($value in $SensitiveValues) {
        if (-not [string]::IsNullOrEmpty($value)) { $safe = $safe.Replace($value, '[REDACTED]') }
    }
    $safe = [regex]::Replace($safe, '(?i)Bearer\s+[^\s"'']+', 'Bearer [REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)https?://[^\s"'']+', '[REDACTED_URL]')
    $safe = [regex]::Replace($safe, '(?i)[A-Z]:\\[^\r\n"'']+', '[REDACTED_PATH]')
    if ($safe.Length -gt 262144) { $safe = $safe.Substring(0, 262144) + "`n[TRUNCATED]" }
    return $safe
}

function Assert-ArtifactSafe {
    param([string[]]$Paths, [string[]]$SensitiveValues)
    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        foreach ($value in $SensitiveValues) {
            Assert-Condition ([string]::IsNullOrEmpty($value) -or -not $text.Contains($value, [System.StringComparison]::OrdinalIgnoreCase)) 'artifact privacy gate rejected a sensitive literal'
        }
        Assert-Condition ($text -notmatch '(?i)Authorization\s*[:=]|Bearer\s+|https?://') 'artifact privacy gate rejected credential or URL shaped data'
    }
}

function Invoke-SelfTest {
    $defaultRounds = @(Resolve-DiagnosticRounds -DefaultConcurrency 50 -DefaultDurationSeconds 60 -RoundSpecification '' -ConcurrencyWasBound $false -DurationWasBound $false -RoundsWasBound $false)
    Assert-Condition ($defaultRounds.Count -eq 1 -and $defaultRounds[0].StageName -eq 'independent-50' -and $defaultRounds[0].Concurrency -eq 50 -and $defaultRounds[0].DurationSeconds -eq 60) 'self-test default diagnostic round parsing failed'
    $customRounds = @(Resolve-DiagnosticRounds -DefaultConcurrency 50 -DefaultDurationSeconds 60 -RoundSpecification '25x30, 50X60,100x90' -ConcurrencyWasBound $false -DurationWasBound $false -RoundsWasBound $true)
    Assert-Condition ($customRounds.Count -eq 3 -and $customRounds[0].StageName -eq 'round-01-vu-25' -and $customRounds[2].Concurrency -eq 100 -and $customRounds[2].DurationSeconds -eq 90) 'self-test multi-round diagnostic parsing failed'
    $boundaryRounds = @(Resolve-DiagnosticRounds -DefaultConcurrency 50 -DefaultDurationSeconds 60 -RoundSpecification '1x30,500x300' -ConcurrencyWasBound $false -DurationWasBound $false -RoundsWasBound $true)
    Assert-Condition ($boundaryRounds[0].Concurrency -eq 1 -and $boundaryRounds[0].DurationSeconds -eq 30 -and $boundaryRounds[1].Concurrency -eq 500 -and $boundaryRounds[1].DurationSeconds -eq 300) 'self-test diagnostic boundary parsing failed'
    $repeatedRounds = @(Resolve-DiagnosticRounds -DefaultConcurrency 50 -DefaultDurationSeconds 60 -RoundSpecification '50x60,50x60' -ConcurrencyWasBound $false -DurationWasBound $false -RoundsWasBound $true)
    Assert-Condition ($repeatedRounds[0].StageName -eq 'round-01-vu-50' -and $repeatedRounds[1].StageName -eq 'round-02-vu-50') 'self-test repeated concurrency did not receive unique stage names'
    foreach ($invalidSingle in @(@('0', '60'), @('501', '60'), @('50', '29'), @('50', '301'), @('1.5', '60'), @('50', '59.5'))) {
        $rejected = $false
        try { $null = Resolve-DiagnosticRounds -DefaultConcurrency $invalidSingle[0] -DefaultDurationSeconds $invalidSingle[1] -RoundSpecification '' -ConcurrencyWasBound $true -DurationWasBound $true -RoundsWasBound $false } catch { $rejected = $true }
        Assert-Condition $rejected 'self-test accepted invalid single-round parameters'
    }
    foreach ($invalidRounds in @('', '0x60', '501x60', '50x29', '50x301', '50:60', '50x60,', '50x300,50x300,50x300,50x300,50x300', '1x30,1x30,1x30,1x30,1x30,1x30,1x30,1x30,1x30,1x30,1x30,1x30,1x30')) {
        $rejected = $false
        try { $null = Resolve-DiagnosticRounds -DefaultConcurrency 50 -DefaultDurationSeconds 60 -RoundSpecification $invalidRounds -ConcurrencyWasBound $false -DurationWasBound $false -RoundsWasBound $true } catch { $rejected = $true }
        Assert-Condition $rejected 'self-test accepted an invalid diagnostic round plan'
    }
    $conflictingRoundsRejected = $false
    try { $null = Resolve-DiagnosticRounds -DefaultConcurrency 75 -DefaultDurationSeconds 60 -RoundSpecification '25x60' -ConcurrencyWasBound $true -DurationWasBound $false -RoundsWasBound $true } catch { $conflictingRoundsRejected = $true }
    Assert-Condition $conflictingRoundsRejected 'self-test accepted conflicting single-round and multi-round parameters'
    Assert-TestServiceName 'reader-sync-dev-test.service'
    Assert-OptionalProductionServiceName 'reader-sync.service' 'reader-sync-dev-test.service'
    Assert-RemoteRoot '/tmp/capacity-selftest' | Out-Null
    Assert-DirectHost 'capacity.example.invalid'
    Assert-DirectHost '2001:db8::10'
    Assert-FixtureId 'w0123456789a'
    $validCandidateSha = '0123456789abcdef' * 4
    Assert-OptionalTestBinarySha256 $validCandidateSha
    Assert-OptionalTestBinarySha256 ''
    foreach ($invalidCandidateSha in @(
        ($validCandidateSha.Substring(0, 63))
        ($validCandidateSha + '0')
        ($validCandidateSha.ToUpperInvariant())
        ('g' + $validCandidateSha.Substring(1))
    )) {
        $rejected = $false
        try { Assert-OptionalTestBinarySha256 $invalidCandidateSha } catch { $rejected = $true }
        Assert-Condition $rejected 'self-test accepted an invalid test binary SHA-256'
    }
    $candidateConfig = @{ testBinarySha256 = $validCandidateSha }
    Assert-Condition ((Get-ConfigValue @{} $candidateConfig 'TestBinarySha256' 'testBinarySha256' '') -eq $validCandidateSha) 'self-test private candidate SHA precedence failed'
    $overrideCandidateSha = 'abcdef0123456789' * 4
    Assert-Condition ((Get-ConfigValue @{ TestBinarySha256 = $overrideCandidateSha } $candidateConfig 'TestBinarySha256' 'testBinarySha256' '') -eq $overrideCandidateSha) 'self-test explicit candidate SHA precedence failed'
    Assert-Condition ((Get-ConfigValue @{} @{} 'TestBinarySha256' 'testBinarySha256' '') -eq '') 'self-test empty candidate SHA mode failed'
    $setting = Get-ConfigValue -Bound @{ DirectHost = 'parameter.example.invalid' } -Config @{ directHost = 'config.example.invalid' } -ParameterName 'DirectHost' -ConfigName 'directHost' -Default 'default.example.invalid'
    Assert-Condition ($setting -eq 'parameter.example.invalid') 'self-test found broken explicit parameter precedence'
    foreach ($invalidHost in @('localhost', '127.0.0.1', '0.0.0.0', '::1', '::')) {
        $rejected = $false
        try { Assert-DirectHost $invalidHost } catch { $rejected = $true }
        Assert-Condition $rejected 'self-test expected direct host rejection'
    }
    foreach ($invalid in @('reader-sync.service', 'dev-test', '../dev-test.service')) {
        $rejected = $false
        try { Assert-TestServiceName $invalid } catch { $rejected = $true }
        Assert-Condition $rejected 'self-test expected service rejection'
    }
    foreach ($invalid in @('/', '/tmp/../capacity', '/tmp/general')) {
        $rejected = $false
        try { Assert-RemoteRoot $invalid | Out-Null } catch { $rejected = $true }
        Assert-Condition $rejected 'self-test expected remote root rejection'
    }
    foreach ($invalidFixture in @('w0123456789', 'W0123456789a', 'w0123456789g', '../w012345678')) {
        $rejected = $false
        try { Assert-FixtureId $invalidFixture } catch { $rejected = $true }
        Assert-Condition $rejected 'self-test expected fixture ID rejection'
    }
    $tempBase = Get-AbsolutePath ([System.IO.Path]::GetTempPath())
    $temp = Join-Path $tempBase ('kunpeng-capacity-selftest-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $temp
    try {
        $tokens = Join-Path $temp 'tokens.txt'
        Set-PrivateAcl -Path $temp -Directory
        [System.IO.File]::WriteAllLines($tokens, @('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd'), $script:Utf8NoBom)
        Set-PrivateAcl -Path $tokens
        Assert-Condition (Test-TokenFile -Path $tokens -ExpectedCount 4) 'self-test valid token fixture was rejected'
        [System.IO.File]::WriteAllLines($tokens, @('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'cccccccccccccccc', 'dddddddddddddddd'), $script:Utf8NoBom)
        Assert-Condition (-not (Test-TokenFile -Path $tokens -ExpectedCount 4)) 'self-test duplicate token fixture was accepted'
        $privateBytes = Join-Path $temp 'private-bytes.bin'
        Write-PrivateBytes -Path $privateBytes -Bytes ([byte[]](1, 2, 3))
        Write-PrivateBytes -Path $privateBytes -Bytes ([byte[]](4, 5, 6))
        Assert-Condition ([System.IO.File]::ReadAllBytes($privateBytes)[0] -eq 4) 'self-test private byte overwrite failed'
        $proxyNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')
        $originalProxyValues = @{}
        foreach ($name in $proxyNames) {
            $originalProxyValues[$name] = [System.Environment]::GetEnvironmentVariable($name, [System.EnvironmentVariableTarget]::Process)
            [System.Environment]::SetEnvironmentVariable($name, 'http://proxy.example.invalid:8888', [System.EnvironmentVariableTarget]::Process)
        }
        try {
            $info = New-K6ProcessInfo -Executable 'k6.exe' -ScriptPath 'capacity-k6.js' -SummaryPath 'summary.json' -WorkingDirectory $temp -BaseUrl 'https://secret.example.invalid:12345' -TokenFile 'C:\private\tokens.txt' -StageName 'round-01-vu-75' -DurationSeconds 90 -Concurrency 75
        } finally {
            foreach ($name in $proxyNames) {
                [System.Environment]::SetEnvironmentVariable($name, $originalProxyValues[$name], [System.EnvironmentVariableTarget]::Process)
            }
        }
        $arguments = @($info.ArgumentList) -join ' '
        Assert-Condition ($arguments -notmatch 'secret\.example|private\\tokens') 'self-test found private values in k6 arguments'
        Assert-Condition ($info.Environment['SYNC_LOAD_TEST_BASE'] -match '^https://') 'self-test found missing k6 environment injection'
        Assert-Condition ($info.Environment['SYNC_LOAD_TEST_SINGLE_STAGE_NAME'] -eq 'round-01-vu-75' -and $info.Environment['SYNC_LOAD_TEST_STAGE_SECONDS'] -eq '90' -and $info.Environment['SYNC_LOAD_TEST_SINGLE_CONCURRENCY'] -eq '75') 'self-test found incorrect round-specific k6 environment injection'
        Assert-Condition ($arguments -match '--insecure-skip-tls-verify') 'self-test found missing temporary TLS flag'
        foreach ($name in $proxyNames) {
            Assert-Condition (-not $info.Environment.ContainsKey($name)) 'self-test found a proxy variable in the k6 process environment'
        }
        Assert-Condition ($info.Environment['NO_PROXY'] -eq '*' -and $info.Environment['no_proxy'] -eq '*') 'self-test found missing k6 no-proxy enforcement'
        $lockPath = Join-Path $temp '.capacity-run.lock'
        $firstLock = Enter-CapacityRunLock -Path $lockPath
        try {
            $lockRejected = $false
            try { $secondLock = Enter-CapacityRunLock -Path $lockPath } catch { $lockRejected = $true }
            Assert-Condition $lockRejected 'self-test allowed concurrent Windows capacity runs'
        } finally {
            $firstLock.Dispose()
        }
        $reopenedLock = Enter-CapacityRunLock -Path $lockPath
        $reopenedLock.Dispose()
        $remoteLockSimulation = Start-CapturedProcess (New-ProcessInfo -FilePath (Get-Command pwsh.exe -ErrorAction Stop).Source -Arguments @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'
        ))
        Assert-RemoteCapacityLockAlive $remoteLockSimulation
        Assert-Condition (Stop-CapturedProcessSafe $remoteLockSimulation) 'self-test could not stop a simulated remote lock process'
        $lostLockRejected = $false
        try { Assert-RemoteCapacityLockAlive $remoteLockSimulation } catch { $lostLockRejected = $true }
        Assert-Condition $lostLockRejected 'self-test accepted an exited remote lock process'
        Assert-Condition (Stop-RemoteCapacityLock $null '' '') 'self-test rejected an unused remote lock'
        Assert-Condition (Stop-RemoteCapacityMonitor -Wrapper '' -IdentityPath '' -ExpectedMonitorPath '' -ExpectedOutputPath '') 'self-test rejected an unused remote monitor'
        $registerCommand = Get-PendingFixtureRegisterCommand -RemoteRoot '/tmp/capacity-selftest' -Service 'reader-sync-dev-test.service' -FixtureId 'w0123456789a'
        $recoveryCommand = Get-PendingFixtureRecoveryCommand -RemoteRoot '/tmp/capacity-selftest' -RemoteSeeder '/tmp/capacity-selftest/windows-20260825T000000Z-01234567/fixture-seed.py' -Service 'reader-sync-dev-test.service'
        foreach ($command in @($registerCommand, $recoveryCommand)) {
            Assert-Condition ($command -match 'target_fingerprint|target_fingerprint=') 'self-test found missing recovery target binding'
            Assert-Condition ($command -notmatch 'Bearer|postgres(?:ql)?://') 'self-test found a secret-shaped recovery command'
        }
        Assert-Condition ($recoveryCommand -match 'for attempt in 1 2 3') 'self-test found missing pending cleanup retry'
        $remoteCleanupCommand = Get-RemoteRunCleanupCommand -RemoteRoot '/tmp/capacity-selftest' -RemoteRun '/tmp/capacity-selftest/windows-20260825T000000Z-01234567'
        $remoteRenameIndex = $remoteCleanupCommand.IndexOf('mv -T -- "$run" "$quarantine"', [System.StringComparison]::Ordinal)
        $remoteDeleteIndex = $remoteCleanupCommand.IndexOf('rm -rf -- "$quarantine"', [System.StringComparison]::Ordinal)
        Assert-Condition ($remoteRenameIndex -ge 0 -and $remoteDeleteIndex -gt $remoteRenameIndex -and -not $remoteCleanupCommand.Contains('rm -rf -- "$run"', [System.StringComparison]::Ordinal)) 'self-test found non-atomic remote run cleanup'
        $rejected = $false
        try { $null = Get-RemoteRunCleanupCommand -RemoteRoot '/tmp/capacity-selftest' -RemoteRun '/tmp/capacity-selftest/pending' } catch { $rejected = $true }
        Assert-Condition $rejected 'self-test accepted a non-run remote cleanup target'
        Assert-DirectCleanupOutput -Values @{ direct_control = 'clean' }
        Assert-DirectCleanupOutput -Values @{
            direct_control = 'clean'; service_restored = 'true'; production_active_before = 'true'
            production_active_after = 'true'; production_unchanged = 'true'; caddy_test_port_reference_count = '0'
        } -RequireRestorationEvidence
        $stoppable = Start-CapturedProcess (New-ProcessInfo -FilePath (Get-Command pwsh.exe -ErrorAction Stop).Source -Arguments @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'
        ))
        Assert-Condition (Stop-CapturedProcessSafe $stoppable) 'self-test could not confirm child-process termination'
        Assert-Condition $stoppable.Process.HasExited 'self-test left a child process running'
        $safe = Join-Path $temp 'safe.json'
        [System.IO.File]::WriteAllText($safe, '{"complete":true}', $script:Utf8NoBom)
        Assert-ArtifactSafe -Paths @($safe) -SensitiveValues @('secret.example.invalid')
        [System.IO.File]::WriteAllText($safe, '{"url":"https://secret.example.invalid"}', $script:Utf8NoBom)
        $rejected = $false
        try { Assert-ArtifactSafe -Paths @($safe) -SensitiveValues @('secret.example.invalid') } catch { $rejected = $true }
        Assert-Condition $rejected 'self-test expected artifact privacy rejection'
    } finally {
        $resolved = Get-AbsolutePath $temp
        Assert-Condition (Test-PathWithin $resolved $tempBase) 'self-test cleanup escaped the temporary root'
        if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
    Write-Output 'windows_capacity_runner_self_test=passed'
}

function Invoke-CapacityRun {
    param([Parameter(Mandatory)][object[]]$DiagnosticRounds)
    Assert-Condition ($PSVersionTable.PSVersion.Major -ge 7) 'PowerShell 7 or newer is required'
    Assert-Condition ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) 'this runner is Windows-only'
    Assert-Condition ($DiagnosticRounds.Count -ge 1 -and $DiagnosticRounds.Count -le 12) 'diagnostic round plan is unavailable'
    $roundCount = $DiagnosticRounds.Count
    $repositoryRoot = Get-AbsolutePath (Join-Path $PSScriptRoot '..\..\..')
    $bound = @{} + $script:EntryBoundParameters
    $defaultConfig = Join-Path $env:USERPROFILE '.codex\private\kunpeng-reader-capacity-windows.json'
    $configPath = if ($bound.ContainsKey('PrivateConfigPath')) { Get-AbsolutePath $PrivateConfigPath } else { Get-AbsolutePath $defaultConfig }
    $config = Read-PrivateConfig -Path $configPath -Explicit $bound.ContainsKey('PrivateConfigPath') -RepositoryRoot $repositoryRoot

    $alias = [string](Get-ConfigValue $bound $config 'SshAlias' 'sshAlias' 'kunpeng-reader')
    Assert-SafeAlias $alias
    $defaultWrapper = Join-Path $env:USERPROFILE ('.ssh\' + $alias + '-root.ps1')
    $wrapper = [string](Get-ConfigValue $bound $config 'RootWrapperPath' 'rootWrapperPath' $defaultWrapper)
    $wrapper = Assert-LocalPrivatePath -Path $wrapper -RepositoryRoot $repositoryRoot -MustExist -Leaf
    Assert-PrivateAclState -Path $wrapper
    Assert-Condition ([System.IO.Path]::GetExtension($wrapper) -eq '.ps1') 'root wrapper must be a PowerShell script'
    $wrapperSource = [System.IO.File]::ReadAllText($wrapper, [System.Text.Encoding]::UTF8)
    Assert-Condition ($wrapperSource.Contains($alias, [System.StringComparison]::Ordinal)) 'root wrapper does not target the selected restricted SSH alias'
    foreach ($guard in @('BatchMode=yes', '-F', 'NUL')) {
        Assert-Condition ($wrapperSource.Contains($guard, [System.StringComparison]::OrdinalIgnoreCase)) 'root wrapper is missing a non-interactive SSH isolation guard'
    }

    $k6 = [string](Get-ConfigValue $bound $config 'K6Path' 'k6Path' '')
    if ([string]::IsNullOrWhiteSpace($k6)) { $k6 = (Get-Command k6.exe -ErrorAction Stop).Source }
    $k6 = Get-AbsolutePath $k6
    Assert-Condition (Test-Path -LiteralPath $k6 -PathType Leaf) 'k6 executable is unavailable'
    $python = [string](Get-ConfigValue $bound $config 'PythonPath' 'pythonPath' '')
    if ([string]::IsNullOrWhiteSpace($python)) { $python = (Get-Command python.exe -ErrorAction Stop).Source }
    $python = Get-AbsolutePath $python
    Assert-Condition (Test-Path -LiteralPath $python -PathType Leaf) 'native Python executable is unavailable'

    $tokenDefault = Join-Path $env:USERPROFILE '.codex\private\kunpeng-capacity-tokens.txt'
    $tokens = [string](Get-ConfigValue $bound $config 'TokensPath' 'tokensPath' $tokenDefault)
    $tokens = Assert-LocalPrivatePath -Path $tokens -RepositoryRoot $repositoryRoot
    $reportDefault = Join-Path $env:USERPROFILE '.codex\private\kunpeng-load-reports'
    $reportRoot = [string](Get-ConfigValue $bound $config 'ReportDirectory' 'reportDirectory' $reportDefault)
    $reportRoot = Assert-LocalPrivatePath -Path $reportRoot -RepositoryRoot $repositoryRoot
    $hostName = [string](Get-ConfigValue $bound $config 'DirectHost' 'directHost' '')
    if (-not [string]::IsNullOrWhiteSpace($hostName)) { Assert-DirectHost $hostName }
    $remoteRoot = [string](Get-ConfigValue $bound $config 'RemoteRunRoot' 'remoteRunRoot' '/var/tmp/kunpeng-capacity-runs')
    $remoteRoot = Assert-RemoteRoot $remoteRoot
    $service = [string](Get-ConfigValue $bound $config 'TestService' 'testService' 'kunpeng-reader-sync-dev-test.service')
    Assert-TestServiceName $service
    $production = [string](Get-ConfigValue $bound $config 'ProductionService' 'productionService' '')
    Assert-OptionalProductionServiceName $production $service
    $testBinarySha = [string](Get-ConfigValue $bound $config 'TestBinarySha256' 'testBinarySha256' '')
    Assert-OptionalTestBinarySha256 $testBinarySha

    $k6Script = Join-Path $PSScriptRoot 'capacity-k6.js'
    $reporter = Join-Path $PSScriptRoot 'capacity-k6-report.py'
    $clientMonitor = Join-Path $PSScriptRoot 'capacity-client-monitor.py'
    $remoteMonitorSource = Join-Path $PSScriptRoot 'capacity-monitor.py'
    $seederSource = Join-Path $PSScriptRoot 'capacity-fixture-seed.py'
    $directSource = Join-Path $PSScriptRoot 'capacity-direct-control.sh'
    foreach ($support in @($k6Script, $reporter, $clientMonitor, $remoteMonitorSource, $seederSource, $directSource)) {
        Assert-Condition (Test-Path -LiteralPath $support -PathType Leaf) 'required capacity support helper is unavailable'
    }

    $versionHandle = Start-CapturedProcess (New-ProcessInfo -FilePath $k6 -Arguments @('version'))
    $versionResult = Complete-CapturedProcess -Handle $versionHandle -TimeoutMilliseconds 10000 -TerminateOnTimeout
    Assert-Condition ($versionResult.ExitCode -eq 0 -and ($versionResult.Stdout + $versionResult.Stderr) -match ('\bv' + [regex]::Escape($script:ExpectedK6Version) + '\b')) 'k6 must be exactly v1.2.3'

    if (-not (Test-Path -LiteralPath $reportRoot -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $reportRoot
    }
    $runLock = Enter-CapacityRunLock -Path (Join-Path $reportRoot '.capacity-run.lock')
    try {
    $runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $runDirectory = Join-Path $reportRoot ('windows-' + $runId)
    Assert-Condition (-not (Test-Path -LiteralPath $runDirectory)) 'run output already exists'
    $null = New-Item -ItemType Directory -Path $runDirectory
    Set-PrivateAcl -Path $runDirectory -Directory

    $summaryPath = $null
    $probePath = $null
    $clientPath = $null
    $remotePath = $null
    $diagnosticPath = Join-Path $runDirectory 'setup-diagnostic.log'
    $manifestPath = Join-Path $runDirectory 'manifest.json'
    $remoteRun = "$remoteRoot/windows-$runId"
    $remoteSeeder = "$remoteRun/fixture-seed.py"
    $remoteDirect = "$remoteRun/direct-control.sh"
    $remoteMonitor = "$remoteRun/capacity-monitor.py"
    $remoteTokens = "$remoteRun/tokens.txt"
    $remoteReport = $null
    $fixtureId = 'w' + [Guid]::NewGuid().ToString('N').Substring(0, 11)
    $pendingFixtureRegistered = $false
    $fixtureCleanupSucceeded = $false
    $generatedLocalTokens = $false
    $remoteInitialized = $false
    $helpersUploaded = $false
    $directTouched = $false
    $directPrepared = $false
    $recoveredPendingFixtures = 0
    $runSucceeded = $false
    $manifest = $null
    $mainFailure = $null
    $mainFailurePhase = ''
    $phase = 'local-preflight'
    $cleanupFailures = [System.Collections.Generic.List[string]]::new()
    $k6Output = ''
    $k6Handle = $null
    $clientHandle = $null
    $watcherHandle = $null
    $watcherResult = $null
    $remoteLockHandle = $null
    $remoteMonitorIdentity = ''
    $remoteMonitorRegistered = $false
    $remoteMonitorCleanupVerified = $true
    $fixtureTargetFingerprint = ''

    try {
        $phase = 'root-wrapper-probe'
        $probe = Invoke-RootCommand -Wrapper $wrapper -Command "printf '%s' root_wrapper=ready"
        Assert-Condition ($probe -eq 'root_wrapper=ready') 'root wrapper readiness check failed'
        $phase = 'direct-host-resolution'
        if ([string]::IsNullOrWhiteSpace($hostName)) {
            $hostName = Resolve-DirectHostFromRootConnection -Wrapper $wrapper
        }
        $phase = 'remote-run-initialization'
        $rootLiteral = ConvertTo-ShellLiteral $remoteRoot
        $runLiteral = ConvertTo-ShellLiteral $remoteRun
        $initializeRemote = @'
set -eu
root=__ROOT__
run=__RUN__
if test ! -e "$root"; then
  install -d -m 0700 -o root -g root -- "$root"
fi
test -d "$root"
test ! -L "$root"
test "$(stat -c %u -- "$root")" = 0
test "$(stat -c %a -- "$root")" = 700
test ! -e "$run"
case "$run" in "$root"/windows-*) ;; *) exit 51;; esac
umask 077
mkdir -m 0700 -- "$run"
'@
        $initializeRemote = $initializeRemote.Replace('__ROOT__', $rootLiteral).Replace('__RUN__', $runLiteral)
        $null = Invoke-RootCommand -Wrapper $wrapper -Command $initializeRemote
        $remoteInitialized = $true
        $phase = 'remote-capacity-lock'
        $remoteLockHandle = Start-RemoteCapacityLock -Wrapper $wrapper -RemoteRoot $remoteRoot -RemoteRun $remoteRun
        $phase = 'helper-upload'
        Send-RemoteFile $wrapper $seederSource $remoteSeeder
        Send-RemoteFile $wrapper $directSource $remoteDirect
        Send-RemoteFile $wrapper $remoteMonitorSource $remoteMonitor
        $helpersUploaded = $true
        Assert-RemoteCapacityLockAlive $remoteLockHandle

        # Recover an exact state left by an interrupted earlier invocation
        # before creating accounts or exposing the listener again. Attempt the
        # direct and fixture recoveries independently, then fail closed if
        # either one could not be confirmed.
        $startupRecoveryFailures = 0
        $phase = 'stale-direct-cleanup'
        $directTouched = $true
        try {
            $preCleanup = 'bash {0} cleanup --service {1}' -f (ConvertTo-ShellLiteral $remoteDirect), (ConvertTo-ShellLiteral $service)
            if ($production) { $preCleanup += ' --production-service ' + (ConvertTo-ShellLiteral $production) }
            $preCleanupOutput = Parse-ControlOutput (Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command $preCleanup)
            Assert-DirectCleanupOutput -Values $preCleanupOutput
        } catch { $startupRecoveryFailures++ }

        $phase = 'pending-fixture-recovery'
        try {
            $pendingRecovery = Parse-ControlOutput (Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command (Get-PendingFixtureRecoveryCommand -RemoteRoot $remoteRoot -RemoteSeeder $remoteSeeder -Service $service))
            Assert-Condition ($pendingRecovery.Count -eq 1 -and $pendingRecovery.ContainsKey('recovered_pending_fixtures')) 'pending fixture recovery returned an unexpected response'
            Assert-Condition ([int]::TryParse([string]$pendingRecovery.recovered_pending_fixtures, [ref]$recoveredPendingFixtures) -and $recoveredPendingFixtures -ge 0 -and $recoveredPendingFixtures -le 4096) 'pending fixture recovery count is invalid'
        } catch { $startupRecoveryFailures++ }
        $phase = 'startup-recovery-gate'
        Assert-Condition ($startupRecoveryFailures -eq 0) 'startup recovery did not complete safely'
        Assert-RemoteCapacityLockAlive $remoteLockHandle

        $phase = 'fixture-recovery-registration'
        $pendingRegistration = Parse-ControlOutput (Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command (Get-PendingFixtureRegisterCommand -RemoteRoot $remoteRoot -Service $service -FixtureId $fixtureId))
        Assert-Condition (
            $pendingRegistration.Count -eq 2 -and
            $pendingRegistration.fixture_recovery -eq 'pending' -and
            [string]$pendingRegistration.target_fingerprint -cmatch '^[a-f0-9]{64}$'
        ) 'fixture recovery registration was not confirmed'
        $fixtureTargetFingerprint = [string]$pendingRegistration.target_fingerprint
        $pendingFixtureRegistered = $true
        Assert-RemoteCapacityLockAlive $remoteLockHandle

        $cachedTokenShapeValid = Test-TokenFile -Path $tokens
        if ($cachedTokenShapeValid) { Assert-PrivateAclState -Path $tokens }
        # A local 2048-line file is not proof that the corresponding sessions
        # still exist in the disposable database. Seed a fresh, aggregate-
        # verified pool for every run and remove it during mandatory cleanup.
        $trustedRemotePool = $false
        if (-not $trustedRemotePool) {
            $phase = 'fixture-seed'
            $seedCommand = 'python3 {0} seed --service {1} --fixture-id {2} --token-output {3} --expected-target-fingerprint {4}' -f (
                ConvertTo-ShellLiteral $remoteSeeder), (ConvertTo-ShellLiteral $service), (ConvertTo-ShellLiteral $fixtureId), (ConvertTo-ShellLiteral $remoteTokens), (ConvertTo-ShellLiteral $fixtureTargetFingerprint)
            $seedOutput = Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command $seedCommand
            try { $seedReport = $seedOutput | ConvertFrom-Json } catch { throw 'fixture seeder returned an invalid aggregate response' }
            Assert-Condition ($seedReport.ok -eq $true -and $seedReport.requestedAccountCount -eq 2048) 'fixture seeder did not verify the requested pool'
            foreach ($field in @('accountCount', 'verifiedAccountCount', 'sessionCount', 'activeSessionCount', 'distinctSessionDigestCount', 'generationCount', 'generationOneCount', 'zeroCursorGenerationCount', 'storageLedgerCount', 'zeroStorageLedgerCount', 'uniqueTokenCount')) {
                Assert-Condition ($seedReport.$field -eq 2048) 'fixture seeder aggregate verification was incomplete'
            }
            Assert-Condition ($seedReport.disabledAccountCount -eq 0 -and $seedReport.tokenFileMode -eq 384) 'fixture seeder returned an unsafe account or token state'
            try {
                $phase = 'fixture-download-transfer'
                $tokenTemporary = Join-Path $runDirectory 'downloaded-tokens.txt'
                Receive-RemoteFile -Wrapper $wrapper -RemotePath $remoteTokens -LocalPath $tokenTemporary -MaximumBytes 4194304
                $phase = 'fixture-download-validation'
                Assert-Condition (Test-TokenFile -Path $tokenTemporary) 'rebuilt token fixture failed the 2048-unique preflight'
                $bytes = [System.IO.File]::ReadAllBytes($tokenTemporary)
                $phase = 'fixture-install'
                $generatedLocalTokens = $true
                Write-PrivateBytes -Path $tokens -Bytes $bytes
                $phase = 'fixture-install-validation'
                Assert-Condition (Test-TokenFile -Path $tokens) 'installed token fixture failed verification'
                Assert-PrivateAclState -Path $tokens
            } finally {
                try {
                    $null = Invoke-RootCommand -Wrapper $wrapper -Command ("rm -f -- " + (ConvertTo-ShellLiteral $remoteTokens))
                } finally {
                    if (Test-Path -LiteralPath (Join-Path $runDirectory 'downloaded-tokens.txt')) { Remove-Item -LiteralPath (Join-Path $runDirectory 'downloaded-tokens.txt') -Force }
                }
            }
        }

        Assert-RemoteCapacityLockAlive $remoteLockHandle
        $phase = 'direct-prepare'
        $prepareArgs = 'bash {0} prepare --service {1}' -f (ConvertTo-ShellLiteral $remoteDirect), (ConvertTo-ShellLiteral $service)
        if ($production) { $prepareArgs += ' --production-service ' + (ConvertTo-ShellLiteral $production) }
        if ($testBinarySha) { $prepareArgs += ' --test-binary-sha256 ' + (ConvertTo-ShellLiteral $testBinarySha) }
        $direct = Parse-ControlOutput (Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command $prepareArgs)
        Assert-Condition (
            $direct.direct_control -eq 'prepared' -and
            $direct.scheme -eq 'https' -and
            $direct.production_unchanged -eq 'true' -and
            $direct.caddy_test_port_reference_count -eq '0'
        ) 'temporary direct HTTPS preparation failed'
        $directPrepared = $true
        $expectedBinaryMode = if ($testBinarySha) { 'verified-candidate' } else { 'production-equivalent' }
        Assert-Condition ($direct.binary_mode -eq $expectedBinaryMode) 'temporary direct HTTPS binary provenance gate failed'
        $expectedServiceSha = [string]$direct.test_binary_sha256
        Assert-Condition ($expectedServiceSha -cmatch '^[a-f0-9]{64}$') 'temporary direct HTTPS returned an invalid running binary digest'
        $port = 0
        Assert-Condition ([int]::TryParse([string]$direct.port, [ref]$port) -and $port -ge 1024 -and $port -le 65535) 'temporary direct HTTPS returned an invalid test port'
        $phase = 'direct-status'
        $status = Parse-ControlOutput (Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command ('bash {0} status --service {1}' -f (ConvertTo-ShellLiteral $remoteDirect), (ConvertTo-ShellLiteral $service)))
        Assert-Condition (
            $status.direct_control -eq 'prepared' -and
            $status.scheme -eq 'https' -and
            [int]$status.port -eq $port -and
            $status.binary_mode -eq $expectedBinaryMode -and
            $status.test_binary_sha256 -eq $expectedServiceSha -and
            $status.firewall_source_matches_current_ssh -eq 'true' -and
            $status.caddy_test_port_reference_count -eq '0' -and
            $status.production_active -eq 'true' -and
            $status.production_unchanged -eq 'true'
        ) 'temporary direct HTTPS status did not match preparation'
        $baseUrl = ([System.UriBuilder]::new('https', $hostName, $port)).Uri.AbsoluteUri.TrimEnd('/')
        $phase = 'direct-client-preflight'
        Assert-DirectHttpsReachable -BaseUrl $baseUrl

        $roundResults = [System.Collections.Generic.List[object]]::new()
        $reportFiles = [System.Collections.Generic.List[string]]::new()
        foreach ($roundPlan in $DiagnosticRounds) {
            $roundIndexValue = $roundResults.Count + 1
            $stageName = [string]$roundPlan.StageName
            $roundConcurrency = [int]$roundPlan.Concurrency
            $roundDurationSeconds = [int]$roundPlan.DurationSeconds
            $remoteMonitorSeconds = $roundDurationSeconds + 15
            $artifactPrefix = if ($roundCount -eq 1) { '' } else { $stageName + '-' }
            $summaryName = $artifactPrefix + 'k6-summary.json'
            $probeName = $artifactPrefix + 'probe-report.json'
            $clientName = $artifactPrefix + 'client-monitor.json'
            $remoteName = $artifactPrefix + 'remote-monitor.json'
            $diagnosticName = $artifactPrefix + 'k6-diagnostic.log'
            $summaryPath = Join-Path $runDirectory $summaryName
            $probePath = Join-Path $runDirectory $probeName
            $clientPath = Join-Path $runDirectory $clientName
            $remotePath = Join-Path $runDirectory $remoteName
            $diagnosticPath = Join-Path $runDirectory $diagnosticName
            $remoteReport = "$remoteRun/monitor-$roundIndexValue.json"
            $remoteMonitorCleanupVerified = $false
            $remoteMonitorIdentity = "$remoteReport.identity"
            $remoteMonitorRegistered = $false
            $k6Output = ''
            $k6Handle = $null
            $clientHandle = $null
            $watcherHandle = $null
            $watcherResult = $null

        $phase = 'remote-monitor-start'
        $monitorCommand = @'
set -eu
service=__SERVICE__
monitor=__MONITOR__
output=__OUTPUT__
identity=__IDENTITY__
cancel="${identity}.cancel"
test ! -e "$cancel"
test ! -L "$cancel"
case "$service" in *dev-test*) ;; *) exit 41;; esac
test ! -e "$identity"
test ! -L "$identity"
pid="$(systemctl show -p MainPID --value "$service")"
test "$pid" -gt 0
database="$(python3 - "$pid" <<'PY'
import re, sys
from urllib.parse import unquote, urlsplit
with open(f"/proc/{sys.argv[1]}/environ", "rb") as source:
    entries = source.read().split(b"\0")
url = next((row.split(b"=", 1)[1].decode() for row in entries if row.startswith(b"KUNPENG_SYNC_DATABASE_URL=")), "")
name = unquote(urlsplit(url).path.lstrip("/"))
if not re.fullmatch(r"reader_sync_rust_test_[A-Za-z0-9_]+", name):
    raise SystemExit(1)
print(name)
PY
)"
guard="${identity}.guard"
test ! -e "$guard"
test ! -L "$guard"
test ! -e "$cancel"
test ! -L "$cancel"
python3 - "$guard" "$monitor" "$output" <<'PY'
import os, sys

path, monitor, output = sys.argv[1:]
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
descriptor = os.open(path, flags, 0o600)
try:
    payload = (
        "remote_capacity_monitor_launch=registered\n"
        f"monitor={monitor}\n"
        f"output={output}\n"
    ).encode()
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("short write while registering monitor launch")
        view = view[written:]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
test -f "$guard"
test ! -L "$guard"
test "$(stat -c %u -- "$guard")" = 0
test "$(stat -c %a -- "$guard")" = 600
test "$(stat -c %h -- "$guard")" = 1
test ! -e "$cancel"
run_capacity_monitor() {
  set -euo pipefail
  local identity="$1"
  local monitor="$2"
  local output="$3"
  local service_pid="$4"
  local database="$5"
  local expected_sha="$6"
  local port="$7"
  local seconds="$8"
  local stage="$9"
  local monitor_pid="$$"
  local monitor_starttime
  local identity_tmp="${identity}.tmp.$$"
  local guard="${identity}.guard"
  local cancel="${identity}.cancel"
  exec 9<>"$guard"
  flock -x 9
  test -f "$guard"
  test ! -L "$guard"
  test "$(stat -c %u -- "$guard")" = 0
  test "$(stat -c %a -- "$guard")" = 600
  test "$(stat -c %h -- "$guard")" = 1
  mapfile -t guard_rows <&9
  test "${#guard_rows[@]}" = 3
  test "${guard_rows[0]}" = 'remote_capacity_monitor_launch=registered'
  test "${guard_rows[1]}" = "monitor=$monitor"
  test "${guard_rows[2]}" = "output=$output"
  test ! -e "$cancel" || exit 70
  test ! -e "$identity"
  test ! -L "$identity"
  test ! -e "$identity_tmp"
  test ! -L "$identity_tmp"
  monitor_starttime="$(awk '{print $22}' "/proc/$monitor_pid/stat")"
  [[ "$monitor_starttime" =~ ^[1-9][0-9]*$ ]]
  trap 'rm -f -- "$identity_tmp"' EXIT
  umask 077
  printf 'remote_capacity_monitor=running\npid=%s\nstarttime=%s\nmonitor=%s\noutput=%s\n' "$monitor_pid" "$monitor_starttime" "$monitor" "$output" > "$identity_tmp"
  chmod 0600 "$identity_tmp"
  mv -T -- "$identity_tmp" "$identity"
  trap - EXIT
  flock -u 9
  exec python3 "$monitor" --service-pid "$service_pid" --expected-service-sha256 "$expected_sha" --postgres-database "$database" --metrics-url "https://127.0.0.1:${port}/metrics" --seconds "$seconds" --output "$output" --single-stage --single-stage-name "$stage"
}
export -f run_capacity_monitor
nohup bash -c 'run_capacity_monitor "$@"' _ "$identity" "$monitor" "$output" "$pid" "$database" __EXPECTED_SERVICE_SHA__ __PORT__ __MONITOR_SECONDS__ __STAGE_NAME__ >"${output}.startup.log" 2>&1 </dev/null &
monitor_pid=$!
for _ in $(seq 1 10); do
  if test -s "$identity" && test -s "$output" && kill -0 "$monitor_pid" 2>/dev/null; then
    test -f "$identity"
    test ! -L "$identity"
    test "$(stat -c %u -- "$identity")" = 0
    test "$(stat -c %a -- "$identity")" = 600
    test "$(stat -c %h -- "$identity")" = 1
    mapfile -t identity_rows < "$identity"
    test "${#identity_rows[@]}" = 5
    test "${identity_rows[0]}" = 'remote_capacity_monitor=running'
    test "${identity_rows[1]}" = "pid=$monitor_pid"
    monitor_starttime="${identity_rows[2]#starttime=}"
    [[ "$monitor_starttime" =~ ^[1-9][0-9]*$ ]]
    test "$(awk '{print $22}' "/proc/$monitor_pid/stat")" = "$monitor_starttime"
    test "${identity_rows[3]}" = "monitor=$monitor"
    test "${identity_rows[4]}" = "output=$output"
    state="$(python3 - "$output" __EXPECTED_SERVICE_SHA__ <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as source:
        report = json.load(source)
except (OSError, ValueError):
    print("invalid")
    raise SystemExit(0)
if (report.get("complete") is False and
        report.get("identityStable") is True and
        report.get("serviceIdentity", {}).get("sha256") == sys.argv[2]):
    print("started")
else:
    print("invalid")
PY
)"
    if test "$state" = started; then
      printf 'monitor=started\nmonitor_pid=%s\nmonitor_starttime=%s\n' "$monitor_pid" "$monitor_starttime"
      exit 0
    fi
  fi
  kill -0 "$monitor_pid" 2>/dev/null || exit 42
  sleep 1
done
exit 43
'@
        $monitorCommand = $monitorCommand.Replace('__SERVICE__', (ConvertTo-ShellLiteral $service)).Replace('__MONITOR__', (ConvertTo-ShellLiteral $remoteMonitor)).Replace('__OUTPUT__', (ConvertTo-ShellLiteral $remoteReport)).Replace('__IDENTITY__', (ConvertTo-ShellLiteral $remoteMonitorIdentity)).Replace('__PORT__', [string]$port).Replace('__MONITOR_SECONDS__', [string]$remoteMonitorSeconds).Replace('__STAGE_NAME__', (ConvertTo-ShellLiteral $stageName)).Replace('__EXPECTED_SERVICE_SHA__', (ConvertTo-ShellLiteral $expectedServiceSha))
        $monitorStart = Parse-ControlOutput (Invoke-RootCommand -Wrapper $wrapper -Command $monitorCommand)
        $monitorPid = 0
        $monitorStarttime = 0L
        Assert-Condition ($monitorStart.Count -eq 3 -and $monitorStart.monitor -eq 'started' -and [int]::TryParse([string]$monitorStart.monitor_pid, [ref]$monitorPid) -and $monitorPid -gt 1 -and [long]::TryParse([string]$monitorStart.monitor_starttime, [ref]$monitorStarttime) -and $monitorStarttime -gt 0) 'remote monitor did not start with a valid process identity'
        $remoteMonitorRegistered = $true

        $phase = 'remote-monitor-watch-start'
        $watchCommand = @'
set -eu
monitor_pid=__MONITOR_PID__
report=__REPORT__
expected=__EXPECTED_SERVICE_SHA__
read_state() {
  if test ! -s "$report"; then
    printf 'missing\n'
    return
  fi
  python3 - "$report" "$expected" <<'PY'
import json, os, sys, time
try:
    with open(sys.argv[1], encoding="utf-8") as source:
        report = json.load(source)
except (OSError, ValueError):
    print("invalid")
    raise SystemExit(0)
if report.get("serviceIdentity", {}).get("sha256") != sys.argv[2]:
    print("identity_failed")
elif report.get("identityStable") is False:
    print("identity_failed")
elif report.get("complete") is True and report.get("identityStable") is True:
    print("complete")
elif report.get("complete") is False and report.get("identityStable") is True:
    print("stale" if time.time() - os.path.getmtime(sys.argv[1]) > 5 else "running")
else:
    print("invalid")
PY
}
for _ in $(seq 1 __WATCH_ITERATIONS__); do
  state="$(read_state)"
  case "$state" in
    identity_failed) printf 'monitor_watch=identity_failed\n'; exit 42 ;;
    complete) printf 'monitor_watch=complete\n'; exit 0 ;;
    stale) printf 'monitor_watch=stale\n'; exit 46 ;;
    running|missing) ;;
    *) printf 'monitor_watch=invalid\n'; exit 43 ;;
  esac
  if ! kill -0 "$monitor_pid" 2>/dev/null; then
    state="$(read_state)"
    if test "$state" = complete; then
      printf 'monitor_watch=complete\n'
      exit 0
    fi
    if test "$state" = identity_failed; then
      printf 'monitor_watch=identity_failed\n'
      exit 42
    fi
    printf 'monitor_watch=stopped\n'
    exit 44
  fi
  sleep 0.5
done
printf 'monitor_watch=timeout\n'
exit 45
'@
        $watchIterations = ($remoteMonitorSeconds + 20) * 2
        $watchCommand = $watchCommand.Replace('__MONITOR_PID__', [string]$monitorPid).Replace('__REPORT__', (ConvertTo-ShellLiteral $remoteReport)).Replace('__EXPECTED_SERVICE_SHA__', (ConvertTo-ShellLiteral $expectedServiceSha)).Replace('__WATCH_ITERATIONS__', [string]$watchIterations)
        $watcherInfo = New-ProcessInfo -FilePath (Get-Command pwsh.exe -ErrorAction Stop).Source -Arguments @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $wrapper, $watchCommand
        )
        $watcherHandle = Start-CapturedProcess $watcherInfo
        if ($watcherHandle.Process.WaitForExit(250)) {
            $watcherResult = Complete-CapturedProcess -Handle $watcherHandle -TimeoutMilliseconds 1000
            throw 'remote service identity monitor stopped before load'
        }
        Assert-RemoteCapacityLockAlive $remoteLockHandle

        $phase = 'pre-load-lock-fence'
        $preLoadFence = Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command "printf '%s' remote_capacity_lock=pre_load_fenced"
        Assert-Condition ($preLoadFence -eq 'remote_capacity_lock=pre_load_fenced') 'remote capacity lock fence failed before load'
        Assert-RemoteCapacityLockAlive $remoteLockHandle

        $phase = 'load-execution'
        $k6Handle = Start-CapturedProcess (New-K6ProcessInfo -Executable $k6 -ScriptPath $k6Script -SummaryPath $summaryPath -WorkingDirectory $runDirectory -BaseUrl $baseUrl -TokenFile $tokens -StageName $stageName -DurationSeconds $roundDurationSeconds -Concurrency $roundConcurrency)
        $clientInfo = New-ProcessInfo -FilePath $python -WorkingDirectory $runDirectory -Arguments @(
            $clientMonitor, '--pid', [string]$k6Handle.Process.Id, '--seconds', [string]$roundDurationSeconds,
            '--output', $clientPath, '--single-stage', '--single-stage-name', $stageName
        )
        $clientHandle = Start-CapturedProcess $clientInfo
        $loadTimer = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not $k6Handle.Process.WaitForExit(250)) {
            if ($remoteLockHandle.Process.HasExited) {
                $k6Stopped = Stop-CapturedProcessSafe $k6Handle
                $clientStopped = Stop-CapturedProcessSafe $clientHandle
                Assert-Condition ($k6Stopped -and $clientStopped) 'remote capacity lock was lost and local load termination could not be confirmed'
                throw 'remote capacity lock was lost while load was active; load was terminated'
            }
            if ($watcherHandle.Process.HasExited) {
                $watcherResult = Complete-CapturedProcess -Handle $watcherHandle -TimeoutMilliseconds 1000
                $k6Stopped = Stop-CapturedProcessSafe $k6Handle
                $clientStopped = Stop-CapturedProcessSafe $clientHandle
                Assert-Condition ($k6Stopped -and $clientStopped) 'remote service identity monitor ended while load was active and local load termination could not be confirmed'
                throw 'remote service identity monitor ended while load was active; load was terminated'
            }
            if ($loadTimer.ElapsedMilliseconds -gt (($roundDurationSeconds + 20) * 1000)) {
                $k6Stopped = Stop-CapturedProcessSafe $k6Handle
                $clientStopped = Stop-CapturedProcessSafe $clientHandle
                Assert-Condition ($k6Stopped -and $clientStopped) 'k6 diagnostic timed out and local load termination could not be confirmed'
                throw 'k6 diagnostic timed out and was terminated'
            }
        }
        $phase = 'load-lock-fence'
        Assert-RemoteCapacityLockAlive $remoteLockHandle
        $lockFence = Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command "printf '%s' remote_capacity_lock=fenced"
        Assert-Condition ($lockFence -eq 'remote_capacity_lock=fenced') 'remote capacity lock fence failed after load'
        $phase = 'load-completion'
        $k6Result = Complete-CapturedProcess -Handle $k6Handle -TimeoutMilliseconds 5000
        $clientResult = Complete-CapturedProcess -Handle $clientHandle -TimeoutMilliseconds 15000 -TerminateOnTimeout
        if ($null -eq $watcherResult) {
            $watcherResult = Complete-CapturedProcess -Handle $watcherHandle -TimeoutMilliseconds 25000 -TerminateOnTimeout
        }
        $watcherState = if ($watcherResult.ExitCode -eq 0) { Parse-ControlOutput $watcherResult.Stdout } else { @{} }
        $k6Output = $k6Result.Stdout + "`n" + $k6Result.Stderr
        Assert-Condition ($watcherResult.ExitCode -eq 0 -and $watcherState.Count -eq 1 -and $watcherState.monitor_watch -eq 'complete') 'remote service identity monitor did not complete safely'
        Assert-Condition ($k6Result.ExitCode -eq 0) 'k6 diagnostic did not complete'
        Assert-Condition ($clientResult.ExitCode -eq 0) 'Windows k6 client monitor did not complete'
        Assert-Condition (Test-Path -LiteralPath $summaryPath -PathType Leaf) 'k6 summary was not produced'
        Assert-Condition (Test-Path -LiteralPath $clientPath -PathType Leaf) 'Windows client report was not produced'
        $phase = 'remote-monitor-exit-confirmation'
        Assert-Condition (Stop-RemoteCapacityMonitor -Wrapper $wrapper -IdentityPath $remoteMonitorIdentity -ExpectedMonitorPath $remoteMonitor -ExpectedOutputPath $remoteReport -RequireIdentity) 'remote capacity monitor process did not stop cleanly'
        $remoteMonitorCleanupVerified = $true
        $remoteMonitorRegistered = $false
        $remoteMonitorIdentity = ''

        $phase = 'load-report-conversion'
        $reporterHandle = Start-CapturedProcess (New-ProcessInfo -FilePath $python -WorkingDirectory $runDirectory -Arguments @(
            $reporter, '--summary', $summaryPath, '--output', $probePath,
            '--stage-seconds', [string]$roundDurationSeconds,
            '--single-stage-name', $stageName,
            '--single-stage-concurrency', [string]$roundConcurrency,
            '--execution-model', $script:ExecutionModel,
            '--account-pool-size', [string]$script:ExpectedTokenCount,
            '--profile', $script:Profile
        ))
        $reporterResult = Complete-CapturedProcess -Handle $reporterHandle -TimeoutMilliseconds 30000 -TerminateOnTimeout
        Assert-Condition ($reporterResult.ExitCode -eq 0 -and (Test-Path -LiteralPath $probePath -PathType Leaf)) 'capacity report conversion failed'

        $phase = 'remote-monitor-download'
        Receive-RemoteFile -Wrapper $wrapper -RemotePath $remoteReport -LocalPath $remotePath

        $phase = 'report-validation'
        $probeJson = [System.IO.File]::ReadAllText($probePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-Condition ($probeJson.workloadClass -eq 'non-capacity-diagnostic' -and $probeJson.capacityConclusionEligible -eq $false) 'probe classification is unsafe'
        Assert-Condition ($probeJson.measurementComplete -eq $true -and $probeJson.stages.Count -eq 1) 'probe measurement is incomplete'
        $stage = $probeJson.stages[0]
        Assert-Condition ($stage.name -eq $stageName -and $stage.activeVus -eq $roundConcurrency -and $stage.plannedSeconds -eq $roundDurationSeconds) 'probe stage shape is invalid'
        Assert-Condition ($stage.accountCoverageComplete -eq $true -and $stage.shardClaimsValid -eq $true -and $stage.stageCutoff -eq 0) 'probe coverage/accounting gate failed'
        $clientJson = [System.IO.File]::ReadAllText($clientPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $minimumClientSamples = [Math]::Max(1, $roundDurationSeconds - 5)
        Assert-Condition ($clientJson.complete -eq $true -and $clientJson.hardware.byStage.$stageName.samples -ge $minimumClientSamples) 'Windows client hardware report is incomplete'
        Assert-Condition ($null -ne $clientJson.hardware.overall.clientCpuMaxPercent -and $null -ne $clientJson.hardware.overall.clientRssMaxKiB -and $null -ne $clientJson.hardware.overall.memAvailableMinKiB) 'Windows client hardware fields are incomplete'
        $remoteJson = [System.IO.File]::ReadAllText($remotePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-Condition ($remoteJson.complete -eq $true -and $remoteJson.identityStable -eq $true -and $remoteJson.serviceIdentity.sha256 -eq $expectedServiceSha -and $remoteJson.hardware.byStage.$stageName.samples -ge $roundDurationSeconds) 'remote API/PostgreSQL report is incomplete or service identity changed'

        $phase = 'artifact-privacy-validation'
        $sensitive = @($hostName, $baseUrl, $tokens, $configPath, $wrapper, $remoteRoot, $remoteRun, $service, $production, $fixtureTargetFingerprint)
        $safeDiagnostic = Get-SanitizedDiagnostic -Text $k6Output -SensitiveValues $sensitive
        Write-PrivateText -Path $diagnosticPath -Text $safeDiagnostic
        Assert-ArtifactSafe -Paths @($summaryPath, $probePath, $clientPath, $remotePath, $diagnosticPath) -SensitiveValues $sensitive
            $roundReports = @($summaryName, $probeName, $clientName, $remoteName, $diagnosticName)
            foreach ($reportFile in $roundReports) { $reportFiles.Add($reportFile) }
            $roundResults.Add([pscustomobject]@{
                Index = $roundIndexValue
                StageName = $stageName
                Concurrency = $roundConcurrency
                DurationSeconds = $roundDurationSeconds
                Stage = $stage
                ClientJson = $clientJson
                RemoteJson = $remoteJson
                Reports = $roundReports
            })
        }
        Assert-Condition ($roundResults.Count -eq $roundCount) 'not all requested diagnostic rounds completed'
        $manifest = [ordered]@{
            runId = $runId
            workloadClass = 'non-capacity-diagnostic'
            k6Version = $script:ExpectedK6Version
            profile = $script:Profile
            executionModel = $script:ExecutionModel
            binaryMode = $expectedBinaryMode
            testBinarySha256 = $expectedServiceSha
            roundCount = $roundResults.Count
            maxActiveVus = [int](($roundResults | Measure-Object -Property Concurrency -Maximum).Maximum)
            totalPlannedSeconds = [int](($roundResults | Measure-Object -Property DurationSeconds -Sum).Sum)
            rounds = @($roundResults | ForEach-Object {
                [ordered]@{
                    index = $_.Index
                    stageName = $_.StageName
                    activeVus = $_.Concurrency
                    plannedSeconds = $_.DurationSeconds
                    reports = $_.Reports
                }
            })
            accountPoolSize = $script:ExpectedTokenCount
            temporaryTlsVerificationSkipped = $true
            recoveredPendingFixtures = $recoveredPendingFixtures
            reports = @($reportFiles)
        }
        if ($roundResults.Count -eq 1) {
            $manifest['activeVus'] = $roundResults[0].Concurrency
            $manifest['plannedSeconds'] = $roundResults[0].DurationSeconds
        }
        $runSucceeded = $true
    } catch {
        $mainFailure = $_
        $mainFailurePhase = $phase
        try {
            $sensitive = @($hostName, $tokens, $configPath, $wrapper, $remoteRoot, $remoteRun, $service, $production, $fixtureTargetFingerprint)
            $failureDiagnostic = "phase=$mainFailurePhase`nerror=$($_.Exception.Message)`n$k6Output"
            Write-PrivateText -Path $diagnosticPath -Text (Get-SanitizedDiagnostic -Text $failureDiagnostic -SensitiveValues $sensitive)
        } catch {}
    } finally {
        if (-not (Stop-CapturedProcessSafe $k6Handle)) { $cleanupFailures.Add('local k6 process cleanup failed') }
        if (-not (Stop-CapturedProcessSafe $clientHandle)) { $cleanupFailures.Add('local client monitor cleanup failed') }
        if (-not (Stop-CapturedProcessSafe $watcherHandle)) { $cleanupFailures.Add('remote identity watcher connection cleanup failed') }
        if (-not [string]::IsNullOrWhiteSpace($remoteMonitorIdentity)) {
            if (-not (Stop-RemoteCapacityMonitor -Wrapper $wrapper -IdentityPath $remoteMonitorIdentity -ExpectedMonitorPath $remoteMonitor -ExpectedOutputPath $remoteReport -RequireIdentity:$remoteMonitorRegistered)) {
                $cleanupFailures.Add('remote capacity monitor process cleanup failed')
            } else {
                $remoteMonitorCleanupVerified = $true
                $remoteMonitorRegistered = $false
                $remoteMonitorIdentity = ''
            }
        }
        if ($generatedLocalTokens -and (Test-Path -LiteralPath $tokens -PathType Leaf)) {
            try { Remove-Item -LiteralPath $tokens -Force } catch { $cleanupFailures.Add('local rebuilt token cleanup failed') }
        }

        # All global mutations are dispatched by the process that owns the
        # remote flock. If that connection was lost, first stop/drain the old
        # holder and make a short non-blocking reacquisition attempt. Never run
        # direct or fixture recovery outside the guardian.
        $remoteGlobalCleanupRequired = $remoteInitialized -and $helpersUploaded
        $directCleanupVerified = -not $remoteGlobalCleanupRequired
        $pendingCleanupVerified = -not $remoteGlobalCleanupRequired
        for ($cleanupAttempt = 1; $cleanupAttempt -le 2 -and (-not $directCleanupVerified -or -not $pendingCleanupVerified); $cleanupAttempt++) {
            $remoteLockHealthy = $null -ne $remoteLockHandle -and -not $remoteLockHandle.Process.HasExited
            if (-not $remoteLockHealthy) {
                if ($null -ne $remoteLockHandle) {
                    $null = Stop-RemoteCapacityLock -Handle $remoteLockHandle -Wrapper $wrapper -RemoteRun $remoteRun
                    $remoteLockHandle = $null
                }
                try {
                    $remoteLockHandle = Start-RemoteCapacityLock -Wrapper $wrapper -RemoteRoot $remoteRoot -RemoteRun $remoteRun
                    $remoteLockHealthy = $true
                } catch {
                    $remoteLockHealthy = $false
                }
            }
            if (-not $remoteLockHealthy) { continue }

            $lockLostDuringCleanup = $false
            if (-not $directCleanupVerified) {
                try {
                    $directCleanup = 'bash {0} cleanup --service {1}' -f (ConvertTo-ShellLiteral $remoteDirect), (ConvertTo-ShellLiteral $service)
                    if ($production) { $directCleanup += ' --production-service ' + (ConvertTo-ShellLiteral $production) }
                    $cleanupOutput = Parse-ControlOutput (Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command $directCleanup)
                    Assert-DirectCleanupOutput -Values $cleanupOutput -RequireRestorationEvidence:$directPrepared
                    $directCleanupVerified = $true
                } catch {
                    $lockLostDuringCleanup = $true
                }
            }
            if (-not $lockLostDuringCleanup -and -not $pendingCleanupVerified) {
                try {
                    $finalPendingCleanup = Parse-ControlOutput (Invoke-RootCommandWithCapacityLock -Wrapper $wrapper -Handle $remoteLockHandle -RemoteRoot $remoteRoot -RemoteRun $remoteRun -Command (Get-PendingFixtureRecoveryCommand -RemoteRoot $remoteRoot -RemoteSeeder $remoteSeeder -Service $service))
                    $finalPendingCount = 0
                    Assert-Condition (
                        $finalPendingCleanup.Count -eq 1 -and
                        $finalPendingCleanup.ContainsKey('recovered_pending_fixtures') -and
                        [int]::TryParse([string]$finalPendingCleanup.recovered_pending_fixtures, [ref]$finalPendingCount) -and
                        $finalPendingCount -ge 0 -and
                        $finalPendingCount -le 4096
                    ) 'fixture cleanup and recovery marker removal were not confirmed'
                    $pendingCleanupVerified = $true
                    $fixtureCleanupSucceeded = $true
                } catch {
                    $lockLostDuringCleanup = $true
                }
            }
            if ($lockLostDuringCleanup) {
                $directCleanupVerified = $false
                $pendingCleanupVerified = $false
                $fixtureCleanupSucceeded = $false
                $null = Stop-RemoteCapacityLock -Handle $remoteLockHandle -Wrapper $wrapper -RemoteRun $remoteRun
                $remoteLockHandle = $null
                continue
            }
        }
        if (-not $directCleanupVerified) { $cleanupFailures.Add('temporary direct HTTPS cleanup failed under the remote capacity lock') }
        if (-not $pendingCleanupVerified) { $cleanupFailures.Add('fixture cleanup failed under the remote capacity lock') }

        $remoteLockReleased = $false
        if ($null -ne $remoteLockHandle) {
            $remoteLockReleased = Stop-RemoteCapacityLock -Handle $remoteLockHandle -Wrapper $wrapper -RemoteRun $remoteRun
            if (-not $remoteLockReleased) { $cleanupFailures.Add('remote capacity lock release failed') }
        }
        if ($remoteInitialized -and $remoteMonitorCleanupVerified) {
            try {
                $null = Invoke-RootCommand -Wrapper $wrapper -Command (Get-RemoteRunCleanupCommand -RemoteRoot $remoteRoot -RemoteRun $remoteRun)
            } catch { $cleanupFailures.Add('run-scoped remote cleanup failed') }
        } elseif ($remoteInitialized) {
            $cleanupFailures.Add('run-scoped remote cleanup withheld because remote monitor cleanup was not verified')
        }
    }

    if ($null -ne $mainFailure -and $cleanupFailures.Count -gt 0) { throw "capacity diagnostic failed at phase '$mainFailurePhase' and mandatory cleanup also failed" }
    if ($null -ne $mainFailure) { throw "capacity diagnostic failed at phase '$mainFailurePhase'; only sanitized local artifacts were retained" }
    if ($cleanupFailures.Count -gt 0) { throw 'capacity diagnostic completed but mandatory cleanup failed' }
    Assert-Condition ($runSucceeded -and $null -ne $manifest -and $fixtureCleanupSucceeded) 'capacity diagnostic completion state is inconsistent'
    $manifest.complete = $true
    $manifest.cleanupVerified = $true
    $manifest.directHttpsRestored = $true
    $manifest.fixtureRemoved = $true
    $manifestTemporary = Join-Path $runDirectory '.manifest.pending'
    try {
        Write-PrivateText -Path $manifestTemporary -Text (($manifest | ConvertTo-Json -Depth 5 -Compress) + "`n")
        Assert-ArtifactSafe -Paths @($manifestTemporary) -SensitiveValues $sensitive
        [System.IO.File]::Move($manifestTemporary, $manifestPath)
        Assert-PrivateAclState -Path $manifestPath
    } finally {
        if (Test-Path -LiteralPath $manifestTemporary -PathType Leaf) { Remove-Item -LiteralPath $manifestTemporary -Force }
    }
    Write-Output 'profile=catchup'
    Write-Output 'execution_model=independent-vus'
    Write-Output 'capacity_conclusion=non-capacity-independent-smoke'
    Write-Output ("binary_mode={0}" -f $expectedBinaryMode)
    Write-Output ("round_count={0}" -f $roundResults.Count)
    foreach ($roundResult in $roundResults) {
        Write-Output ("diagnostic_round={0}/{1}" -f $roundResult.Index, $roundResults.Count)
        Write-Output ("stage_name={0}" -f $roundResult.StageName)
        Write-Output ("active_vus={0}" -f $roundResult.Concurrency)
        Write-Output ("planned_seconds={0}" -f $roundResult.DurationSeconds)
        Write-Output ("requests={0}" -f $roundResult.Stage.requests)
        Write-Output ("successful_requests={0}" -f $roundResult.Stage.successfulRequests)
        Write-Output ("successful_requests_per_second={0}" -f $roundResult.Stage.successfulRequestsPerSecond)
        Write-Output ("no_response={0}" -f $roundResult.Stage.noResponse)
        Write-Output ("p50_ms={0}" -f $roundResult.Stage.p50Ms)
        Write-Output ("p95_ms={0}" -f $roundResult.Stage.p95Ms)
        Write-Output ("p99_ms={0}" -f $roundResult.Stage.p99Ms)
        Write-Output ("status_counts={0}" -f ($roundResult.Stage.statuses | ConvertTo-Json -Compress))
        $clientHardware = $roundResult.ClientJson.hardware.byStage.PSObject.Properties[$roundResult.StageName].Value
        Write-Output ("client_cpu_mean_percent={0}" -f $clientHardware.clientCpuMeanPercent)
        Write-Output ("client_cpu_max_percent={0}" -f $clientHardware.clientCpuMaxPercent)
        Write-Output ("client_rss_max_kib={0}" -f $clientHardware.clientRssMaxKiB)
        Write-Output ("client_mem_available_min_kib={0}" -f $clientHardware.memAvailableMinKiB)
        $remoteHardware = $roundResult.RemoteJson.hardware.byStage.PSObject.Properties[$roundResult.StageName].Value
        Write-Output ("host_cpu_mean_percent={0}" -f $remoteHardware.hostCpuMeanPercent)
        Write-Output ("host_cpu_max_percent={0}" -f $remoteHardware.hostCpuMaxPercent)
        Write-Output ("api_cpu_mean_percent={0}" -f $remoteHardware.serviceCpuMeanPercent)
        Write-Output ("api_cpu_max_percent={0}" -f $remoteHardware.serviceCpuMaxPercent)
        Write-Output ("api_rss_max_kib={0}" -f $remoteHardware.serviceRssMaxKiB)
        Write-Output ("postgres_cpu_mean_percent={0}" -f $remoteHardware.postgresCpuMeanPercent)
        Write-Output ("postgres_cpu_max_percent={0}" -f $remoteHardware.postgresCpuMaxPercent)
        Write-Output ("postgres_rss_max_kib={0}" -f $remoteHardware.postgresAggregateRssMaxKiB)
        Write-Output ("server_mem_available_min_kib={0}" -f $remoteHardware.memAvailableMinKiB)
    }
    Write-Output 'direct_https_restored=true'
    Write-Output 'fixture_removed=true'
    Write-Output ("recovered_pending_fixtures={0}" -f $recoveredPendingFixtures)
    Write-Output ("run_id=$runId")
    } finally {
        $runLock.Dispose()
    }
}

try {
    if ($SelfTest) {
        Invoke-SelfTest
    } else {
        $roundsToRun = @(Resolve-DiagnosticRounds `
            -DefaultConcurrency $Concurrency `
            -DefaultDurationSeconds $DurationSeconds `
            -RoundSpecification $Rounds `
            -ConcurrencyWasBound ($script:EntryBoundParameters.ContainsKey('Concurrency')) `
            -DurationWasBound ($script:EntryBoundParameters.ContainsKey('DurationSeconds')) `
            -RoundsWasBound ($script:EntryBoundParameters.ContainsKey('Rounds')))
        Invoke-CapacityRun -DiagnosticRounds $roundsToRun
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
