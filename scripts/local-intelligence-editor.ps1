[CmdletBinding()]
param(
  [ValidateSet('Verify', 'StartGpu', 'Stop', 'Status', 'Health', 'Smoke')]
  [string]$Action = 'Status',
  [ValidateRange(4096, 16384)]
  [int]$ContextSize = 8192,
  # Windows GPU allocations can remain visible for a few seconds after the
  # 8B judge process exits.  Wait for that release instead of rejecting a
  # valid 16 GiB 27B handoff on the first sampled value.
  [ValidateRange(0, 120)]
  [int]$GpuReleaseWaitSeconds = 45
)

$ErrorActionPreference = 'Stop'

$artifactName = 'Qwen3.8-27B-UD-Q3_K_XL'
$configuredAlias = 'Qwen3.8-27B-UD-Q3_K_XL'
$artifactSize = 13146393504L
$artifactSha256 = '8C2A45FF85E7674CA185EC8EB6CDEAB0E617ED9D8018CAED0B64380EB2A67A5E'
$runtimeSha256 = 'C8B1E5A66E1BB45854BED3DAAAB116C37E74526E30143D737C67557BAB822359'
$port = 8080
$minimumTotalVramMiB = 16000
# The measured 8K/Q8-KV/MTP configuration uses about 15.1 GiB.  It remains
# the preferred profile.  Windows owns a variable part of display VRAM,
# however, so a 16 GiB card can have only ~13 GiB available even after the
# preceding 8B process exits.  In that case use the same 27B weights with a
# deliberately smaller context, quantised KV and partial GPU offload instead
# of incorrectly declaring the installed 16 GiB edition unusable.
$minimumFreeVramMiB = 15000
$minimumCompactFreeVramMiB = 12800

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is unavailable; the local model must stay outside the repository.'
}

$localRoot = Join-Path $env:LOCALAPPDATA 'kunpeng-reader\local-llm'
$runtimeDir = Join-Path $localRoot 'llama-b10549'
$serverExe = Join-Path $runtimeDir 'llama-server.exe'
$modelPath = Join-Path $localRoot "models\$artifactName\$artifactName.gguf"
$stateDir = Join-Path $localRoot 'services\intelligence-editor-27b'
$statePath = Join-Path $stateDir 'server-state.json'
$stdoutLog = Join-Path $stateDir 'server-stdout.log'
$stderrLog = Join-Path $stateDir 'server-stderr.log'
$baseUrl = "http://127.0.0.1:$port"

function Resolve-NormalizedPath([string]$Path) {
  [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-Artifact {
  Assert-RuntimeArtifact
  if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) {
    throw "The verified $artifactName artifact is missing: $modelPath"
  }
  $item = Get-Item -LiteralPath $modelPath
  if ($item.Length -ne $artifactSize) {
    throw "$artifactName size mismatch: expected $artifactSize, got $($item.Length)."
  }
  $actualHash = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualHash -ne $artifactSha256) {
    throw "$artifactName SHA-256 mismatch: expected $artifactSha256, got $actualHash."
  }
  [ordered]@{
    model = $artifactName
    configuredAlias = $configuredAlias
    path = $modelPath
    bytes = $item.Length
    sha256 = $actualHash
    runtimeSha256 = $runtimeSha256
  }
}

function Assert-RuntimeArtifact {
  if (-not (Test-Path -LiteralPath $serverExe -PathType Leaf)) {
    throw "llama-server.exe was not found: $serverExe"
  }
  $actualHash = (Get-FileHash -LiteralPath $serverExe -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualHash -ne $runtimeSha256) {
    throw "llama-server.exe SHA-256 mismatch: expected $runtimeSha256, got $actualHash."
  }
}

function Get-EditorialGpu {
  $rows = @(& nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits 2>$null)
  if ($LASTEXITCODE -ne 0 -or $rows.Count -eq 0) {
    throw 'No NVIDIA GPU or driver was detected; Qwen 27B (16 GB VRAM edition) cannot start.'
  }
  $devices = foreach ($line in $rows) {
    $parts = @(([string]$line).Split(',') | ForEach-Object { $_.Trim() })
    if ($parts.Count -lt 4) { continue }
    $index = 0
    $total = 0
    $free = 0
    if (-not [int]::TryParse($parts[0], [ref]$index)) { continue }
    if (-not [int]::TryParse($parts[-2], [ref]$total)) { continue }
    if (-not [int]::TryParse($parts[-1], [ref]$free)) { continue }
    [pscustomobject]@{
      Index = $index
      Name = ($parts[1..($parts.Count - 3)] -join ', ')
      TotalMiB = $total
      FreeMiB = $free
    }
  }
  $capacityDevices = @($devices | Where-Object { [int]$_.TotalMiB -ge $minimumTotalVramMiB })
  $selectionPool = if ($capacityDevices.Count -gt 0) { $capacityDevices } else { @($devices) }
  $selected = $selectionPool | Sort-Object -Property @(
    @{ Expression = 'FreeMiB'; Descending = $true },
    @{ Expression = 'TotalMiB'; Descending = $true },
    @{ Expression = 'Index'; Descending = $false }
  ) | Select-Object -First 1
  if (-not $selected) { throw 'NVIDIA GPU memory information could not be parsed.' }
  if ([int]$selected.TotalMiB -lt $minimumTotalVramMiB) {
    throw "Qwen 27B (16 GB VRAM edition) requires at least $minimumTotalVramMiB MiB physical VRAM on one GPU. Selected CUDA$($selected.Index) reports $($selected.TotalMiB) MiB."
  }
  if ([int]$selected.FreeMiB -lt $minimumCompactFreeVramMiB) {
    throw "Qwen 27B cannot start because CUDA$($selected.Index) has only $($selected.FreeMiB) MiB free VRAM; at least $minimumCompactFreeVramMiB MiB is required after the previous intelligence model is stopped. Close other GPU applications and retry."
  }
  $selected
}

function Resolve-EditorialProfile($Gpu) {
  if ([int]$Gpu.FreeMiB -ge $minimumFreeVramMiB) {
    return [pscustomobject]@{
      Name = 'full-gpu-mtp'
      ContextSize = $ContextSize
      GpuLayers = 'all'
      CacheTypeK = 'q8_0'
      CacheTypeV = 'q8_0'
      MtpEnabled = $true
    }
  }
  # Qwen3 27B has 64 transformer layers.  Keeping 52 on CUDA leaves enough
  # room for the desktop compositor and a 4K context on common 16 GiB cards;
  # remaining layers stay in RAM.  This is slower than the full MTP profile,
  # but preserves factual 27B synthesis and lets unattended daily processing
  # continue without asking users to close unrelated applications.
  return [pscustomobject]@{
    Name = 'compact-gpu'
    ContextSize = [Math]::Min($ContextSize, 4096)
    GpuLayers = '52'
    CacheTypeK = 'q4_0'
    CacheTypeV = 'q4_0'
    MtpEnabled = $false
  }
}

function Wait-EditorialGpu {
  $deadline = [DateTime]::UtcNow.AddSeconds($GpuReleaseWaitSeconds)
  $lastCapacityError = $null
  while ($true) {
    try {
      return Get-EditorialGpu
    } catch {
      # Only retry the explicitly transient state after a controlled 8B →
      # 27B handoff. Missing drivers, malformed GPU output, a too-small card,
      # and any other hardware error must still fail immediately.
      if ($_.Exception.Message -notmatch '(?i)has only \d+ MiB free VRAM') {
        throw
      }
      $lastCapacityError = $_
      if ([DateTime]::UtcNow -ge $deadline) { break }
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Qwen 27B GPU memory was not released within $GpuReleaseWaitSeconds seconds after the previous model stopped. $($lastCapacityError.Exception.Message)"
}

function Get-State {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
  try { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $null }
}

function Get-TrackedProcess {
  $state = Get-State
  if (-not $state -or -not $state.processId) { return $null }
  $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.processId)" -ErrorAction SilentlyContinue
  if (-not $info -or -not $info.ExecutablePath -or -not $info.CommandLine) { return $null }
  if ((Resolve-NormalizedPath $info.ExecutablePath) -ne (Resolve-NormalizedPath $serverExe)) { return $null }
  if (-not $info.CommandLine.Contains($modelPath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
  if (-not $info.CommandLine.Contains("--port $port", [StringComparison]::OrdinalIgnoreCase)) { return $null }
  $info
}

function Get-PortOwner {
  try {
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop |
      Select-Object -First 1
  } catch { $null }
}

function Test-Health([int]$TimeoutSeconds = 2) {
  try {
    $tracked = Get-TrackedProcess
    $listener = Get-PortOwner
    if (-not $tracked -or -not $listener -or [int]$listener.OwningProcess -ne [int]$tracked.ProcessId) { return $false }
    $health = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/health" -TimeoutSec $TimeoutSeconds
    if ($health.StatusCode -ne 200) { return $false }
    $models = Invoke-RestMethod -Uri "$baseUrl/v1/models" -TimeoutSec $TimeoutSeconds
    @($models.data | ForEach-Object { [string]$_.id }) -contains $configuredAlias
  } catch { $false }
}

function Assert-NoGpuLlamaConflict {
  $tracked = Get-TrackedProcess
  $trackedId = if ($tracked) { [int]$tracked.ProcessId } else { -1 }
  $conflicts = Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      [int]$_.ProcessId -ne $trackedId -and (
        ([string]$_.CommandLine).Contains('--device CUDA', [StringComparison]::OrdinalIgnoreCase) -or
        ([string]$_.CommandLine).Contains('--gpu-layers all', [StringComparison]::OrdinalIgnoreCase)
      )
    }
  if ($conflicts) {
    throw "The 27B editorial phase is GPU-exclusive. Stop the tracked 8B judge first. Conflicting PIDs: $(($conflicts.ProcessId) -join ', ')."
  }
}

function Wait-Health([int]$TimeoutSeconds = 300) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-TrackedProcess)) {
      $tail = if (Test-Path -LiteralPath $stderrLog) {
        (Get-Content -LiteralPath $stderrLog -Tail 30) -join [Environment]::NewLine
      } else { 'No stderr log was produced.' }
      throw "The 27B editorial service exited during startup.`n$tail"
    }
    if (Test-Health 2) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "The 27B editorial service did not become healthy within $TimeoutSeconds seconds."
}

function Start-Editor {
  Assert-Artifact | Out-Null
  $tracked = Get-TrackedProcess
  if ($tracked -and (Test-Health 2)) {
    Write-Host "The 27B editorial service is already healthy (PID $($tracked.ProcessId))."
    return
  }
  if ($tracked) { throw "Tracked PID $($tracked.ProcessId) exists but is unhealthy. Stop it first." }
  $listener = Get-PortOwner
  if ($listener) { throw "127.0.0.1:$port is owned by untracked PID $($listener.OwningProcess)." }
  Assert-NoGpuLlamaConflict
  $gpu = Wait-EditorialGpu
  $profile = Resolve-EditorialProfile $gpu

  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
  $cores = [int](Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum
  if ($cores -lt 1) { $cores = 4 }
  $arguments = @(
    '--model', ('"' + $modelPath + '"'),
    '--alias', $configuredAlias,
    '--host', '127.0.0.1',
    '--port', [string]$port,
    '--cors-origins', 'localhost',
    '--no-cors-credentials',
    '--ctx-size', [string]$profile.ContextSize,
    '--threads', [string]$cores,
    '--threads-batch', [string]$cores,
    '--batch-size', '1024',
    '--ubatch-size', '256',
    '--parallel', '1',
    '--cont-batching',
    '--jinja',
    '--reasoning', 'off',
    '--reasoning-budget', '0',
    '--no-webui',
    '--metrics',
    '--fit', 'off',
    '--cache-type-k', $profile.CacheTypeK,
    '--cache-type-v', $profile.CacheTypeV,
    '--device', "CUDA$($gpu.Index)",
    '--gpu-layers', $profile.GpuLayers,
    '--flash-attn', 'on'
  )
  if ($profile.MtpEnabled) {
    $arguments += @(
      '--spec-type', 'draft-mtp',
      '--spec-draft-n-max', '3',
      '--spec-draft-n-min', '0',
      '--spec-draft-type-k', 'q8_0',
      '--spec-draft-type-v', 'q8_0'
    )
  }
  $started = $null
  $stateTemp = "$statePath.$PID.tmp"
  try {
    $started = Start-Process -FilePath $serverExe -WorkingDirectory $runtimeDir -ArgumentList $arguments -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -PassThru
    [ordered]@{
      processId = $started.Id
      model = $artifactName
      configuredAlias = $configuredAlias
      modelPath = $modelPath
      runtimePath = $serverExe
      runtimeSha256 = $runtimeSha256
      mode = $profile.Name
      gpuIndex = $gpu.Index
      gpuName = $gpu.Name
      totalVramMiB = $gpu.TotalMiB
      freeVramMiBBeforeStart = $gpu.FreeMiB
      host = '127.0.0.1'
      port = $port
      contextSize = $profile.ContextSize
      gpuLayers = $profile.GpuLayers
      mtpEnabled = $profile.MtpEnabled
      startedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $stateTemp -Encoding UTF8
    Move-Item -LiteralPath $stateTemp -Destination $statePath -Force
    Wait-Health
    $listener = Get-PortOwner
    if (-not $listener -or [int]$listener.OwningProcess -ne [int]$started.Id) {
      throw "The healthy listener is not owned by the newly started PID $($started.Id)."
    }
  } catch {
    $failure = $_
    Remove-Item -LiteralPath $stateTemp -Force -ErrorAction SilentlyContinue
    if ($started) {
      $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($started.Id)" -ErrorAction SilentlyContinue
      $candidateMatches = $candidate -and $candidate.ExecutablePath -and $candidate.CommandLine -and (Resolve-NormalizedPath $candidate.ExecutablePath) -eq (Resolve-NormalizedPath $serverExe) -and $candidate.CommandLine.Contains($modelPath, [StringComparison]::OrdinalIgnoreCase) -and $candidate.CommandLine.Contains("--port $port", [StringComparison]::OrdinalIgnoreCase)
      if ($candidateMatches) {
        Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue
      }
      $state = Get-State
      if ($state -and [int]$state.processId -eq [int]$started.Id) {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
      }
    }
    throw $failure
  }
  Write-Host "The 27B editorial service is healthy at $baseUrl (PID $($started.Id))."
}

function Stop-Editor {
  $tracked = Get-TrackedProcess
  if (-not $tracked) {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    return
  }
  $processId = [int]$tracked.ProcessId
  Stop-Process -Id $processId -ErrorAction SilentlyContinue
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) { $process.WaitForExit(15000) | Out-Null }
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { Stop-Process -Id $processId -Force }
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped the tracked 27B editorial service PID $processId."
}

function Invoke-Smoke {
  if (-not (Test-Health 5)) { throw "$baseUrl is not healthy." }
  $request = [ordered]@{
    model = $configuredAlias
    temperature = 0
    max_tokens = 96
    response_format = @{ type = 'json_object' }
    messages = @(
      @{ role = 'system'; content = 'Return valid JSON only.' },
      @{ role = 'user'; content = 'Return {"ok":true,"role":"editor"}.' }
    )
  }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-RestMethod -Method Post -Uri "$baseUrl/v1/chat/completions" -ContentType 'application/json' -Body ($request | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 300
  $watch.Stop()
  $content = [string]$response.choices[0].message.content
  $parsed = $content | ConvertFrom-Json
  if ($parsed.ok -ne $true -or $parsed.role -ne 'editor') { throw "Unexpected 27B smoke response: $content" }
  [ordered]@{
    healthy = $true
    model = $response.model
    latencyMs = [math]::Round($watch.Elapsed.TotalMilliseconds, 1)
    promptTokens = $response.usage.prompt_tokens
    completionTokens = $response.usage.completion_tokens
    tokensPerSecond = if ($response.timings.predicted_per_second) { [math]::Round([double]$response.timings.predicted_per_second, 2) } else { $null }
  } | ConvertTo-Json
}

$mutating = $Action -in @('StartGpu', 'Stop')
$serviceLock = $null
if ($mutating) {
  $serviceLock = [Threading.Mutex]::new($false, 'Local\KunpengReaderIntelligenceEditor27B')
  if (-not $serviceLock.WaitOne(0)) { throw 'Another 27B editor operation is already in progress.' }
}
try {
switch ($Action) {
  'Verify' { Assert-Artifact | ConvertTo-Json }
  'StartGpu' { Start-Editor }
  'Stop' { Stop-Editor }
  'Health' {
    if (-not (Test-Health 5)) { throw "$baseUrl is not healthy." }
    Invoke-RestMethod -Uri "$baseUrl/v1/models" -TimeoutSec 10 | ConvertTo-Json -Depth 8
  }
  'Smoke' { Invoke-Smoke }
  'Status' {
    $tracked = Get-TrackedProcess
    $listener = Get-PortOwner
    [ordered]@{
      model = $artifactName
      configuredAlias = $configuredAlias
      modelPath = $modelPath
      installed = Test-Path -LiteralPath $modelPath -PathType Leaf
      tracked = $null -ne $tracked
      healthy = Test-Health 2
      processId = if ($tracked) { $tracked.ProcessId } else { $null }
      listenerProcessId = if ($listener) { $listener.OwningProcess } else { $null }
      url = $baseUrl
    } | ConvertTo-Json
  }
}
} finally {
  if ($serviceLock) {
    $serviceLock.ReleaseMutex()
    $serviceLock.Dispose()
  }
}
