[CmdletBinding()]
param(
    [switch]$SelfTest,
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
    [string]$ProductionService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ExpectedK6Version = '1.2.3'
$script:ExpectedTokenCount = 2048
$script:StageName = 'independent-50'
$script:DurationSeconds = 60
$script:Concurrency = 50
$script:RemoteMonitorSeconds = 65
$script:Profile = 'catchup'
$script:ExecutionModel = 'independent-vus'
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:EntryBoundParameters = @{} + $PSBoundParameters

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
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
    try {
        $value = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -AsHashtable
    } catch {
        throw 'private config is not valid JSON'
    }
    Assert-Condition ($value -is [hashtable]) 'private config must be a JSON object'
    $allowed = @(
        'scope', 'sshAlias', 'rootWrapperPath', 'k6Path', 'pythonPath', 'tokensPath',
        'reportDirectory', 'directHost', 'remoteRunRoot', 'testService', 'productionService'
    )
    foreach ($key in $value.Keys) {
        Assert-Condition ($key -in $allowed) 'private config contains an unsupported field'
        Assert-Condition ($value[$key] -is [string]) 'private config values must be strings'
    }
    if ($value.ContainsKey('scope')) {
        Assert-Condition ($value.scope -eq 'disposable-dev-test') 'private config scope is not disposable-dev-test'
    }
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

function New-K6ProcessInfo {
    param([string]$Executable, [string]$ScriptPath, [string]$SummaryPath, [string]$WorkingDirectory, [string]$BaseUrl, [string]$TokenFile)
    $environment = @{
        K6_NO_USAGE_REPORT = 'true'
        SYNC_LOAD_TEST_TOKENS_FILE = $TokenFile
        SYNC_LOAD_TEST_BASE = $BaseUrl
        SYNC_LOAD_TEST_STAGE_SECONDS = [string]$script:DurationSeconds
        SYNC_LOAD_TEST_PROFILE = $script:Profile
        SYNC_LOAD_TEST_EXECUTION_MODEL = $script:ExecutionModel
        SYNC_LOAD_TEST_SINGLE_STAGE_NAME = $script:StageName
        SYNC_LOAD_TEST_SINGLE_CONCURRENCY = [string]$script:Concurrency
        SYNC_LOAD_TEST_RUN_EPOCH_MILLIS = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    return New-ProcessInfo -FilePath $Executable -WorkingDirectory $WorkingDirectory -Environment $environment -Arguments @(
        'run', '--quiet', '--insecure-skip-tls-verify', '--summary-export', $SummaryPath, $ScriptPath
    )
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
        Assert-Condition ($line -match '^([a-z_]+)=([A-Za-z0-9._-]+)$') 'direct control returned an unexpected response'
        $values[$Matches[1]] = $Matches[2]
    }
    return $values
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
    Assert-TestServiceName 'reader-sync-dev-test.service'
    Assert-OptionalProductionServiceName 'reader-sync.service' 'reader-sync-dev-test.service'
    Assert-RemoteRoot '/tmp/capacity-selftest' | Out-Null
    Assert-DirectHost 'capacity.example.invalid'
    Assert-DirectHost '2001:db8::10'
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
        $info = New-K6ProcessInfo -Executable 'k6.exe' -ScriptPath 'capacity-k6.js' -SummaryPath 'summary.json' -WorkingDirectory $temp -BaseUrl 'https://secret.example.invalid:12345' -TokenFile 'C:\private\tokens.txt'
        $arguments = @($info.ArgumentList) -join ' '
        Assert-Condition ($arguments -notmatch 'secret\.example|private\\tokens') 'self-test found private values in k6 arguments'
        Assert-Condition ($info.Environment['SYNC_LOAD_TEST_BASE'] -match '^https://') 'self-test found missing k6 environment injection'
        Assert-Condition ($arguments -match '--insecure-skip-tls-verify') 'self-test found missing temporary TLS flag'
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
    Assert-Condition ($PSVersionTable.PSVersion.Major -ge 7) 'PowerShell 7 or newer is required'
    Assert-Condition ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) 'this runner is Windows-only'
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
    $runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $runDirectory = Join-Path $reportRoot ('windows-' + $runId)
    Assert-Condition (-not (Test-Path -LiteralPath $runDirectory)) 'run output already exists'
    $null = New-Item -ItemType Directory -Path $runDirectory
    Set-PrivateAcl -Path $runDirectory -Directory

    $summaryPath = Join-Path $runDirectory 'k6-summary.json'
    $probePath = Join-Path $runDirectory 'probe-report.json'
    $clientPath = Join-Path $runDirectory 'client-monitor.json'
    $remotePath = Join-Path $runDirectory 'remote-monitor.json'
    $diagnosticPath = Join-Path $runDirectory 'k6-diagnostic.log'
    $manifestPath = Join-Path $runDirectory 'manifest.json'
    $remoteRun = "$remoteRoot/windows-$runId"
    $remoteSeeder = "$remoteRun/fixture-seed.py"
    $remoteDirect = "$remoteRun/direct-control.sh"
    $remoteMonitor = "$remoteRun/capacity-monitor.py"
    $remoteTokens = "$remoteRun/tokens.txt"
    $remoteReport = "$remoteRun/monitor.json"
    $fixtureId = 'w' + [Guid]::NewGuid().ToString('N').Substring(0, 11)
    $fixtureSeeded = $false
    $fixtureSeedAttempted = $false
    $generatedLocalTokens = $false
    $remoteInitialized = $false
    $directTouched = $false
    $runSucceeded = $false
    $mainFailure = $null
    $mainFailurePhase = ''
    $phase = 'local-preflight'
    $cleanupFailures = [System.Collections.Generic.List[string]]::new()
    $k6Output = ''

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
        $phase = 'helper-upload'
        $remoteInitialized = $true
        Send-RemoteFile $wrapper $seederSource $remoteSeeder
        Send-RemoteFile $wrapper $directSource $remoteDirect
        Send-RemoteFile $wrapper $remoteMonitorSource $remoteMonitor

        $phase = 'stale-direct-cleanup'
        # Recover an exact state left by an interrupted earlier invocation
        # before creating accounts or exposing the listener again.
        $directTouched = $true
        $preCleanup = 'bash {0} cleanup --service {1}' -f (ConvertTo-ShellLiteral $remoteDirect), (ConvertTo-ShellLiteral $service)
        if ($production) { $preCleanup += ' --production-service ' + (ConvertTo-ShellLiteral $production) }
        $preCleanupOutput = Parse-ControlOutput (Invoke-RootCommand -Wrapper $wrapper -Command $preCleanup)
        Assert-Condition ($preCleanupOutput.direct_control -eq 'clean') 'stale direct HTTPS state could not be cleared'

        $cachedTokenShapeValid = Test-TokenFile -Path $tokens
        if ($cachedTokenShapeValid) { Assert-PrivateAclState -Path $tokens }
        # A local 2048-line file is not proof that the corresponding sessions
        # still exist in the disposable database. Seed a fresh, aggregate-
        # verified pool for every run and remove it during mandatory cleanup.
        $trustedRemotePool = $false
        if (-not $trustedRemotePool) {
            $phase = 'fixture-seed'
            $fixtureSeedAttempted = $true
            $seedCommand = 'python3 {0} seed --service {1} --fixture-id {2} --token-output {3}' -f (
                ConvertTo-ShellLiteral $remoteSeeder), (ConvertTo-ShellLiteral $service), (ConvertTo-ShellLiteral $fixtureId), (ConvertTo-ShellLiteral $remoteTokens)
            $seedOutput = Invoke-RootCommand -Wrapper $wrapper -Command $seedCommand
            try { $seedReport = $seedOutput | ConvertFrom-Json } catch { throw 'fixture seeder returned an invalid aggregate response' }
            Assert-Condition ($seedReport.ok -eq $true -and $seedReport.requestedAccountCount -eq 2048) 'fixture seeder did not verify the requested pool'
            foreach ($field in @('accountCount', 'verifiedAccountCount', 'sessionCount', 'activeSessionCount', 'distinctSessionDigestCount', 'generationCount', 'generationOneCount', 'zeroCursorGenerationCount', 'storageLedgerCount', 'zeroStorageLedgerCount', 'uniqueTokenCount')) {
                Assert-Condition ($seedReport.$field -eq 2048) 'fixture seeder aggregate verification was incomplete'
            }
            Assert-Condition ($seedReport.disabledAccountCount -eq 0 -and $seedReport.tokenFileMode -eq 384) 'fixture seeder returned an unsafe account or token state'
            $fixtureSeeded = $true
            try {
                $phase = 'fixture-download-transfer'
                $tokenTemporary = Join-Path $runDirectory 'downloaded-tokens.txt'
                Receive-RemoteFile -Wrapper $wrapper -RemotePath $remoteTokens -LocalPath $tokenTemporary -MaximumBytes 4194304
                $phase = 'fixture-download-validation'
                Assert-Condition (Test-TokenFile -Path $tokenTemporary) 'rebuilt token fixture failed the 2048-unique preflight'
                $bytes = [System.IO.File]::ReadAllBytes($tokenTemporary)
                $phase = 'fixture-install'
                Write-PrivateBytes -Path $tokens -Bytes $bytes
                $generatedLocalTokens = $true
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

        $phase = 'direct-prepare'
        $prepareArgs = 'bash {0} prepare --service {1}' -f (ConvertTo-ShellLiteral $remoteDirect), (ConvertTo-ShellLiteral $service)
        if ($production) { $prepareArgs += ' --production-service ' + (ConvertTo-ShellLiteral $production) }
        $direct = Parse-ControlOutput (Invoke-RootCommand -Wrapper $wrapper -Command $prepareArgs)
        Assert-Condition ($direct.direct_control -eq 'prepared' -and $direct.scheme -eq 'https') 'temporary direct HTTPS preparation failed'
        $port = 0
        Assert-Condition ([int]::TryParse([string]$direct.port, [ref]$port) -and $port -ge 1024 -and $port -le 65535) 'temporary direct HTTPS returned an invalid test port'
        $phase = 'direct-status'
        $status = Parse-ControlOutput (Invoke-RootCommand -Wrapper $wrapper -Command ('bash {0} status --service {1}' -f (ConvertTo-ShellLiteral $remoteDirect), (ConvertTo-ShellLiteral $service)))
        Assert-Condition ($status.scheme -eq 'https' -and [int]$status.port -eq $port) 'temporary direct HTTPS status did not match preparation'
        $baseUrl = ([System.UriBuilder]::new('https', $hostName, $port)).Uri.AbsoluteUri.TrimEnd('/')

        $phase = 'remote-monitor-start'
        $monitorCommand = @'
set -eu
service=__SERVICE__
monitor=__MONITOR__
output=__OUTPUT__
case "$service" in *dev-test*) ;; *) exit 41;; esac
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
nohup python3 "$monitor" --service-pid "$pid" --postgres-database "$database" --metrics-url https://127.0.0.1:__PORT__/metrics --seconds __MONITOR_SECONDS__ --output "$output" --single-stage --single-stage-name independent-50 >"${output}.startup.log" 2>&1 </dev/null &
monitor_pid=$!
for _ in $(seq 1 10); do
  test -s "$output" && { printf 'monitor=started\n'; exit 0; }
  kill -0 "$monitor_pid" 2>/dev/null || exit 42
  sleep 1
done
kill "$monitor_pid" 2>/dev/null || true
exit 43
'@
        $monitorCommand = $monitorCommand.Replace('__SERVICE__', (ConvertTo-ShellLiteral $service)).Replace('__MONITOR__', (ConvertTo-ShellLiteral $remoteMonitor)).Replace('__OUTPUT__', (ConvertTo-ShellLiteral $remoteReport)).Replace('__PORT__', [string]$port).Replace('__MONITOR_SECONDS__', [string]$script:RemoteMonitorSeconds)
        Assert-Condition ((Invoke-RootCommand -Wrapper $wrapper -Command $monitorCommand) -eq 'monitor=started') 'remote monitor did not start'

        $phase = 'load-execution'
        $k6Handle = Start-CapturedProcess (New-K6ProcessInfo -Executable $k6 -ScriptPath $k6Script -SummaryPath $summaryPath -WorkingDirectory $runDirectory -BaseUrl $baseUrl -TokenFile $tokens)
        $clientInfo = New-ProcessInfo -FilePath $python -WorkingDirectory $runDirectory -Arguments @(
            $clientMonitor, '--pid', [string]$k6Handle.Process.Id, '--seconds', [string]$script:DurationSeconds,
            '--output', $clientPath, '--single-stage', '--single-stage-name', $script:StageName
        )
        $clientHandle = Start-CapturedProcess $clientInfo
        $k6Result = Complete-CapturedProcess -Handle $k6Handle -TimeoutMilliseconds 70000 -TerminateOnTimeout
        $clientResult = Complete-CapturedProcess -Handle $clientHandle -TimeoutMilliseconds 70000 -TerminateOnTimeout
        $k6Output = $k6Result.Stdout + "`n" + $k6Result.Stderr
        Assert-Condition ($k6Result.ExitCode -eq 0) 'k6 diagnostic did not complete'
        Assert-Condition ($clientResult.ExitCode -eq 0) 'Windows k6 client monitor did not complete'
        Assert-Condition (Test-Path -LiteralPath $summaryPath -PathType Leaf) 'k6 summary was not produced'
        Assert-Condition (Test-Path -LiteralPath $clientPath -PathType Leaf) 'Windows client report was not produced'

        $phase = 'load-report-conversion'
        $reporterHandle = Start-CapturedProcess (New-ProcessInfo -FilePath $python -WorkingDirectory $runDirectory -Arguments @(
            $reporter, '--summary', $summaryPath, '--output', $probePath,
            '--stage-seconds', [string]$script:DurationSeconds,
            '--single-stage-name', $script:StageName,
            '--single-stage-concurrency', [string]$script:Concurrency,
            '--execution-model', $script:ExecutionModel,
            '--account-pool-size', [string]$script:ExpectedTokenCount,
            '--profile', $script:Profile
        ))
        $reporterResult = Complete-CapturedProcess -Handle $reporterHandle -TimeoutMilliseconds 30000 -TerminateOnTimeout
        Assert-Condition ($reporterResult.ExitCode -eq 0 -and (Test-Path -LiteralPath $probePath -PathType Leaf)) 'capacity report conversion failed'

        $phase = 'remote-monitor-completion'
        $completeCommand = @'
set -eu
report=__REPORT__
test -s "$report"
python3 - "$report" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    complete = json.load(source).get("complete") is True
raise SystemExit(0 if complete else 1)
PY
printf 'monitor=complete\n'
'@
        $completeCommand = $completeCommand.Replace('__REPORT__', (ConvertTo-ShellLiteral $remoteReport))
        $remoteComplete = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            try {
                if ((Invoke-RootCommand -Wrapper $wrapper -Command $completeCommand) -eq 'monitor=complete') { $remoteComplete = $true; break }
            } catch {}
            Start-Sleep -Seconds 1
        }
        Assert-Condition $remoteComplete 'remote monitor did not complete'
        Receive-RemoteFile -Wrapper $wrapper -RemotePath $remoteReport -LocalPath $remotePath

        $phase = 'report-validation'
        $probeJson = [System.IO.File]::ReadAllText($probePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-Condition ($probeJson.workloadClass -eq 'non-capacity-diagnostic' -and $probeJson.capacityConclusionEligible -eq $false) 'probe classification is unsafe'
        Assert-Condition ($probeJson.measurementComplete -eq $true -and $probeJson.stages.Count -eq 1) 'probe measurement is incomplete'
        $stage = $probeJson.stages[0]
        Assert-Condition ($stage.name -eq $script:StageName -and $stage.activeVus -eq 50 -and $stage.plannedSeconds -eq 60) 'probe stage shape is invalid'
        Assert-Condition ($stage.accountCoverageComplete -eq $true -and $stage.shardClaimsValid -eq $true -and $stage.stageCutoff -eq 0) 'probe coverage/accounting gate failed'
        $clientJson = [System.IO.File]::ReadAllText($clientPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-Condition ($clientJson.complete -eq $true -and $clientJson.hardware.byStage.$($script:StageName).samples -ge 55) 'Windows client hardware report is incomplete'
        Assert-Condition ($null -ne $clientJson.hardware.overall.clientCpuMaxPercent -and $null -ne $clientJson.hardware.overall.clientRssMaxKiB -and $null -ne $clientJson.hardware.overall.memAvailableMinKiB) 'Windows client hardware fields are incomplete'
        $remoteJson = [System.IO.File]::ReadAllText($remotePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-Condition ($remoteJson.complete -eq $true -and $remoteJson.hardware.byStage.$($script:StageName).samples -ge 60) 'remote API/PostgreSQL report is incomplete'

        $phase = 'artifact-privacy-validation'
        $sensitive = @($hostName, $baseUrl, $tokens, $configPath, $wrapper, $remoteRoot, $remoteRun, $service, $production)
        $safeDiagnostic = Get-SanitizedDiagnostic -Text $k6Output -SensitiveValues $sensitive
        Write-PrivateText -Path $diagnosticPath -Text $safeDiagnostic
        Assert-ArtifactSafe -Paths @($summaryPath, $probePath, $clientPath, $remotePath, $diagnosticPath) -SensitiveValues $sensitive
        $manifest = [ordered]@{
            complete = $true
            runId = $runId
            workloadClass = 'non-capacity-diagnostic'
            k6Version = $script:ExpectedK6Version
            profile = $script:Profile
            executionModel = $script:ExecutionModel
            activeVus = $script:Concurrency
            plannedSeconds = $script:DurationSeconds
            accountPoolSize = $script:ExpectedTokenCount
            temporaryTlsVerificationSkipped = $true
            reports = @('k6-summary.json', 'probe-report.json', 'client-monitor.json', 'remote-monitor.json', 'k6-diagnostic.log')
        }
        Write-PrivateText -Path $manifestPath -Text (($manifest | ConvertTo-Json -Depth 5 -Compress) + "`n")
        $runSucceeded = $true
    } catch {
        $mainFailure = $_
        $mainFailurePhase = $phase
        try {
            $sensitive = @($hostName, $tokens, $configPath, $wrapper, $remoteRoot, $remoteRun, $service, $production)
            $failureDiagnostic = "phase=$mainFailurePhase`nerror=$($_.Exception.Message)`n$k6Output"
            Write-PrivateText -Path $diagnosticPath -Text (Get-SanitizedDiagnostic -Text $failureDiagnostic -SensitiveValues $sensitive)
        } catch {}
    } finally {
        if ($remoteInitialized -and $directTouched) {
            try {
                $directCleanup = 'bash {0} cleanup --service {1}' -f (ConvertTo-ShellLiteral $remoteDirect), (ConvertTo-ShellLiteral $service)
                if ($production) { $directCleanup += ' --production-service ' + (ConvertTo-ShellLiteral $production) }
                $cleanupOutput = Parse-ControlOutput (Invoke-RootCommand -Wrapper $wrapper -Command $directCleanup)
                Assert-Condition ($cleanupOutput.direct_control -eq 'clean') 'temporary direct HTTPS cleanup was not confirmed'
            } catch { $cleanupFailures.Add('temporary direct HTTPS cleanup failed') }
        }
        if ($remoteInitialized -and $fixtureSeedAttempted) {
            try {
                $fixtureCleanup = Invoke-RootCommand -Wrapper $wrapper -Command ('python3 {0} cleanup --service {1} --fixture-id {2} --allow-absent' -f (ConvertTo-ShellLiteral $remoteSeeder), (ConvertTo-ShellLiteral $service), (ConvertTo-ShellLiteral $fixtureId))
                $fixtureCleanupReport = $fixtureCleanup | ConvertFrom-Json
                Assert-Condition ($fixtureCleanupReport.ok -eq $true -and $fixtureCleanupReport.requestedAccountCount -eq 2048) 'fixture cleanup was not confirmed'
                $deletedAccounts = [int]$fixtureCleanupReport.deletedAccountCount
                Assert-Condition ($deletedAccounts -eq 0 -or $deletedAccounts -eq 2048) 'fixture cleanup returned a partial pool'
                if ($fixtureSeeded) { Assert-Condition ($deletedAccounts -eq 2048) 'seeded fixture pool was not fully removed' }
                foreach ($field in @('remainingAccountCount', 'remainingSessionCount', 'remainingGenerationCount', 'remainingStorageLedgerCount', 'remainingEntityCount', 'remainingHistoryCount', 'remainingPushReceiptCount', 'remainingDailyUsageCount', 'remainingAssetCount', 'remainingRateLimitBucketCount')) {
                    Assert-Condition ($fixtureCleanupReport.$field -eq 0) 'fixture cleanup left disposable data behind'
                }
            } catch { $cleanupFailures.Add('fixture cleanup failed') }
            if ($generatedLocalTokens -and (Test-Path -LiteralPath $tokens -PathType Leaf)) {
                try { Remove-Item -LiteralPath $tokens -Force } catch { $cleanupFailures.Add('local rebuilt token cleanup failed') }
            }
        }
        if ($remoteInitialized) {
            try {
                $rootLiteral = ConvertTo-ShellLiteral $remoteRoot
                $runLiteral = ConvertTo-ShellLiteral $remoteRun
                $cleanup = "set -eu; case $runLiteral in ${rootLiteral}/windows-*) ;; *) exit 50;; esac; test $runLiteral != /; rm -rf -- $runLiteral"
                $null = Invoke-RootCommand -Wrapper $wrapper -Command $cleanup
            } catch { $cleanupFailures.Add('run-scoped remote cleanup failed') }
        }
    }

    if ($null -ne $mainFailure -and $cleanupFailures.Count -gt 0) { throw "capacity diagnostic failed at phase '$mainFailurePhase' and mandatory cleanup also failed" }
    if ($null -ne $mainFailure) { throw "capacity diagnostic failed at phase '$mainFailurePhase'; only sanitized local artifacts were retained" }
    if ($cleanupFailures.Count -gt 0) { throw 'capacity diagnostic completed but mandatory cleanup failed' }
    Write-Output 'profile=catchup'
    Write-Output 'execution_model=independent-vus'
    Write-Output 'active_vus=50'
    Write-Output 'planned_seconds=60'
    Write-Output 'capacity_conclusion=non-capacity-independent-smoke'
    Write-Output ("requests={0}" -f $stage.requests)
    Write-Output ("successful_requests={0}" -f $stage.successfulRequests)
    Write-Output ("successful_requests_per_second={0}" -f $stage.successfulRequestsPerSecond)
    Write-Output ("no_response={0}" -f $stage.noResponse)
    Write-Output ("p50_ms={0}" -f $stage.p50Ms)
    Write-Output ("p95_ms={0}" -f $stage.p95Ms)
    Write-Output ("p99_ms={0}" -f $stage.p99Ms)
    Write-Output ("status_counts={0}" -f ($stage.statuses | ConvertTo-Json -Compress))
    $clientHardware = $clientJson.hardware.byStage.$($script:StageName)
    Write-Output ("client_cpu_mean_percent={0}" -f $clientHardware.clientCpuMeanPercent)
    Write-Output ("client_cpu_max_percent={0}" -f $clientHardware.clientCpuMaxPercent)
    Write-Output ("client_rss_max_kib={0}" -f $clientHardware.clientRssMaxKiB)
    Write-Output ("client_mem_available_min_kib={0}" -f $clientHardware.memAvailableMinKiB)
    $remoteHardware = $remoteJson.hardware.byStage.$($script:StageName)
    Write-Output ("host_cpu_mean_percent={0}" -f $remoteHardware.hostCpuMeanPercent)
    Write-Output ("host_cpu_max_percent={0}" -f $remoteHardware.hostCpuMaxPercent)
    Write-Output ("api_cpu_mean_percent={0}" -f $remoteHardware.serviceCpuMeanPercent)
    Write-Output ("api_cpu_max_percent={0}" -f $remoteHardware.serviceCpuMaxPercent)
    Write-Output ("api_rss_max_kib={0}" -f $remoteHardware.serviceRssMaxKiB)
    Write-Output ("postgres_cpu_mean_percent={0}" -f $remoteHardware.postgresCpuMeanPercent)
    Write-Output ("postgres_cpu_max_percent={0}" -f $remoteHardware.postgresCpuMaxPercent)
    Write-Output ("postgres_rss_max_kib={0}" -f $remoteHardware.postgresAggregateRssMaxKiB)
    Write-Output ("server_mem_available_min_kib={0}" -f $remoteHardware.memAvailableMinKiB)
    Write-Output 'direct_https_restored=true'
    Write-Output 'fixture_removed=true'
    Write-Output ("run_id=$runId")
}

try {
    if ($SelfTest) { Invoke-SelfTest } else { Invoke-CapacityRun }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
