[CmdletBinding()]
param(
  [ValidateSet('InstallCore', 'InstallCalibration', 'InstallAll', 'Verify', 'VerifyCore', 'VerifyCalibration', 'StartCore', 'StopCore', 'StartEmbedding', 'StartEmbeddingCpu', 'StopEmbedding', 'HealthEmbedding', 'StartReranker', 'StartRerankerCpu', 'StopReranker', 'HealthReranker', 'StartCalibration', 'StartCalibrationCpu', 'StartCalibrationGpu', 'StopCalibration', 'HealthCalibration', 'StopAll', 'Status', 'Smoke')]
  [string]$Action = 'Status',
  # Default stays CPU for compatibility with the intelligence phase controller,
  # which shares these small services while an 8B/27B editor owns the GPU.
  [ValidateSet('auto', 'gpu', 'cpu')]
  [string]$DevicePolicy = 'cpu'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is unavailable; retrieval models must stay outside the repository.'
}

$localRoot = Join-Path $env:LOCALAPPDATA 'kunpeng-reader\local-llm'
$runtimeDir = Join-Path $localRoot 'llama-b10549'
$serverExe = Join-Path $runtimeDir 'llama-server.exe'
$runtimeSha256 = 'C8B1E5A66E1BB45854BED3DAAAB116C37E74526E30143D737C67557BAB822359'
$servicesRoot = Join-Path $localRoot 'services'
$definitions = [ordered]@{
  embedding06 = [ordered]@{
    key = 'embedding06'; alias = 'Qwen3-Embedding-0.6B-Q8_0'; file = 'Qwen3-Embedding-0.6B-Q8_0.gguf'
    repo = 'Qwen/Qwen3-Embedding-0.6B-GGUF'; revision = '370f27d7550e0def9b39c1f16d3fbaa13aa67728'
    bytes = 639150592L; sha256 = '06507C7B42688469C4E7298B0A1E16DEFF06CAF291CF0A5B278C308249C3E439'
    port = 8082; role = 'embedding'; dimensions = 1024
  }
  reranker06 = [ordered]@{
    key = 'reranker06'; alias = 'Qwen3-Reranker-0.6B-Q8_0'; file = 'Qwen3-Reranker-0.6B-Q8_0.gguf'
    remoteFile = 'qwen3-reranker-0.6b-q8_0.gguf'; repo = 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF'
    sourceModel = 'Qwen/Qwen3-Reranker-0.6B'; revision = 'a02f48bb4f057028298c21fa033da2b30d7742d5'
    bytes = 639153184L; sha256 = '22C9979CE4FBCDC5ACDC310C6641C32797EFF1AA980B8F7A2DB8A8EA23429A48'
    port = 8083; role = 'reranker'
  }
  embedding8 = [ordered]@{
    key = 'embedding8'; alias = 'Qwen3-Embedding-8B-Q4_K_M'; file = 'Qwen3-Embedding-8B-Q4_K_M.gguf'
    repo = 'Qwen/Qwen3-Embedding-8B-GGUF'; revision = '69d0e58a13e463cd99a9b83e3f5fee7c10265fab'
    bytes = 4676804928L; sha256 = '3FCD3FEBEC8B3FD64435204DB75BF0DD73B91E8D0661E0331ACFE7E7C3120B85'
    port = 8084; role = 'embedding'; dimensions = 4096
  }
}

function Get-ModelPath($Definition) {
  Join-Path (Join-Path $localRoot "models\$($Definition.alias)") $Definition.file
}

function Get-StateDir($Definition) {
  Join-Path $servicesRoot "intelligence-$($Definition.key)"
}

function Get-StatePath($Definition) {
  Join-Path (Get-StateDir $Definition) 'server-state.json'
}

function Assert-Artifact($Definition) {
  if (-not (Test-Path -LiteralPath $serverExe -PathType Leaf)) { throw "llama-server.exe not found: $serverExe" }
  $runtimeHash = (Get-FileHash -LiteralPath $serverExe -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($runtimeHash -ne $runtimeSha256) {
    throw "llama-server.exe SHA-256 mismatch: expected $runtimeSha256, got $runtimeHash."
  }
  $modelPath = Get-ModelPath $Definition
  if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) { throw "$($Definition.alias) is not installed." }
  $item = Get-Item -LiteralPath $modelPath
  if ($item.Length -ne [long]$Definition.bytes) {
    throw "$($Definition.alias) size mismatch: expected $($Definition.bytes), got $($item.Length)."
  }
  $actualHash = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualHash -ne $Definition.sha256) {
    throw "$($Definition.alias) SHA-256 mismatch: expected $($Definition.sha256), got $actualHash."
  }
  [ordered]@{ model = $Definition.alias; path = $modelPath; bytes = $item.Length; sha256 = $actualHash; revision = $Definition.revision; license = 'Apache-2.0' }
}

function Install-Artifact($Definition) {
  $modelPath = Get-ModelPath $Definition
  $modelDir = Split-Path -Parent $modelPath
  New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
  if (Test-Path -LiteralPath $modelPath -PathType Leaf) {
    $existing = Get-Item -LiteralPath $modelPath
    if ($existing.Length -eq [long]$Definition.bytes) { return Assert-Artifact $Definition }
    if ($existing.Length -gt [long]$Definition.bytes) {
      throw "$($Definition.alias) is larger than the pinned artifact: expected $($Definition.bytes), got $($existing.Length)."
    }
    Write-Host "Resuming $($Definition.alias) at $($existing.Length) of $($Definition.bytes) bytes."
  }
  $remoteFile = if ($Definition.remoteFile) { $Definition.remoteFile } else { $Definition.file }
  $url = "https://huggingface.co/$($Definition.repo)/resolve/$($Definition.revision)/${remoteFile}?download=true"
  $aria2 = Get-Command aria2c.exe -ErrorAction SilentlyContinue
  if ($aria2) {
    & $aria2.Source '--continue=true' '--max-connection-per-server=16' '--split=16' '--min-split-size=4M' '--file-allocation=none' '--auto-file-renaming=false' '--allow-overwrite=false' '--check-certificate=true' "--dir=$modelDir" "--out=$($Definition.file)" $url
  } else {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) { throw 'Neither aria2c.exe nor curl.exe is available.' }
    & $curl.Source '--fail' '--location' '--continue-at' '-' '--output' $modelPath $url
  }
  if ($LASTEXITCODE -ne 0) { throw "Model download failed with exit code $LASTEXITCODE." }
  Assert-Artifact $Definition
}

function Get-State($Definition) {
  $path = Get-StatePath $Definition
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { $null }
}

function Get-TrackedProcess($Definition) {
  $state = Get-State $Definition
  if (-not $state -or -not $state.processId) { return $null }
  $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.processId)" -ErrorAction SilentlyContinue
  if (-not $info -or -not $info.ExecutablePath -or -not $info.CommandLine) { return $null }
  if ([IO.Path]::GetFullPath($info.ExecutablePath) -ne [IO.Path]::GetFullPath($serverExe)) { return $null }
  if (-not $info.CommandLine.Contains((Get-ModelPath $Definition), [StringComparison]::OrdinalIgnoreCase)) { return $null }
  if (-not $info.CommandLine.Contains("--port $($Definition.port)", [StringComparison]::OrdinalIgnoreCase)) { return $null }
  $info
}

function Test-Health($Definition, [int]$TimeoutSeconds = 2) {
  try {
    $tracked = Get-TrackedProcess $Definition
    $listener = Get-PortOwner $Definition
    if (-not $tracked -or -not $listener -or [int]$tracked.ProcessId -ne [int]$listener.OwningProcess) { return $false }
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Definition.port)/health" -TimeoutSec $TimeoutSeconds
    if ($health.StatusCode -ne 200) { return $false }
    $models = Invoke-RestMethod -Uri "http://127.0.0.1:$($Definition.port)/v1/models" -TimeoutSec $TimeoutSeconds
    @($models.data | ForEach-Object { [string]$_.id }) -contains $Definition.alias
  } catch { $false }
}

function Get-PortOwner($Definition) {
  try {
    Get-NetTCPConnection -State Listen -LocalPort $Definition.port -ErrorAction Stop |
      Select-Object -First 1
  } catch { $null }
}

function Assert-NoGpuLlamaConflict($Definition) {
  $conflicts = Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $line = [string]$_.CommandLine
      $usesGpu = $line.Contains('--device CUDA', [StringComparison]::OrdinalIgnoreCase) -or
        $line.Contains('--gpu-layers all', [StringComparison]::OrdinalIgnoreCase)
      $isManagedRetrievalModel = @($definitions.Values | Where-Object {
        $line.Contains($_.alias, [StringComparison]::OrdinalIgnoreCase)
      }).Count -gt 0
      $usesGpu -and -not $isManagedRetrievalModel
    }
  if ($conflicts) {
    throw "GPU calibration is exclusive. Conflicting llama-server PIDs: $(($conflicts.ProcessId) -join ', ')."
  }
}

function Wait-Health($Definition) {
  $deadline = [DateTime]::UtcNow.AddMinutes(4)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-TrackedProcess $Definition)) {
      $log = Join-Path (Get-StateDir $Definition) 'server-stderr.log'
      $tail = if (Test-Path -LiteralPath $log) { (Get-Content -LiteralPath $log -Tail 20) -join [Environment]::NewLine } else { 'No stderr log.' }
      throw "$($Definition.alias) exited during startup.`n$tail"
    }
    if (Test-Health $Definition 2) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$($Definition.alias) startup timed out."
}

function Start-Model($Definition, [ValidateSet('cpu', 'gpu')] [string]$Mode = 'cpu') {
  Assert-Artifact $Definition | Out-Null
  if (-not (Test-Path -LiteralPath $serverExe -PathType Leaf)) { throw "llama-server.exe not found: $serverExe" }
  $tracked = Get-TrackedProcess $Definition
  $state = Get-State $Definition
  if ($tracked -and (Test-Health $Definition 2) -and $state.mode -eq $Mode) { Write-Host "$($Definition.alias) is already healthy in $Mode mode."; return }
  if ($tracked -and (Test-Health $Definition 2)) {
    Stop-Model $Definition
    $tracked = $null
  }
  if ($tracked) { throw "$($Definition.alias) is tracked but unhealthy. Stop it first." }
  $listener = Get-PortOwner $Definition
  if ($listener) { throw "127.0.0.1:$($Definition.port) is owned by untracked PID $($listener.OwningProcess)." }
  if ($Mode -eq 'gpu') { Assert-NoGpuLlamaConflict $Definition }

  $stateDir = Get-StateDir $Definition
  $stdout = Join-Path $stateDir 'server-stdout.log'
  $stderr = Join-Path $stateDir 'server-stderr.log'
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  $cores = [int](Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum
  if ($cores -lt 1) { $cores = 4 }
  $contextSize = if ($Definition.key -eq 'embedding8') { 8192 } else { 4096 }
  $arguments = @('--model', ('"' + (Get-ModelPath $Definition) + '"'), '--alias', $Definition.alias, '--host', '127.0.0.1', '--port', [string]$Definition.port, '--cors-origins', 'localhost', '--no-cors-credentials', '--ctx-size', [string]$contextSize, '--threads', [string]$cores, '--threads-batch', [string]$cores, '--batch-size', '1024', '--ubatch-size', '256', '--parallel', '1', '--no-webui', '--metrics')
  if ($Definition.role -eq 'reranker') { $arguments += @('--embedding', '--reranking', '--pooling', 'rank') }
  else { $arguments += @('--embedding', '--pooling', 'last', '--embd-normalize', '2') }
  if ($Mode -eq 'gpu') { $arguments += @('--fit', 'off', '--device', 'CUDA0', '--gpu-layers', 'all', '--flash-attn', 'on') }
  else { $arguments += @('--device', 'none', '--gpu-layers', '0', '--no-op-offload', '--flash-attn', 'off') }
  $started = $null
  $statePath = Get-StatePath $Definition
  $stateTemp = "$statePath.$PID.tmp"
  try {
    $started = Start-Process -FilePath $serverExe -WorkingDirectory $runtimeDir -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
    [ordered]@{ processId = $started.Id; model = $Definition.alias; modelPath = Get-ModelPath $Definition; runtimePath = $serverExe; runtimeSha256 = $runtimeSha256; role = $Definition.role; mode = $Mode; host = '127.0.0.1'; port = $Definition.port; startedAt = [DateTime]::UtcNow.ToString('o') } |
      ConvertTo-Json | Set-Content -LiteralPath $stateTemp -Encoding UTF8
    Move-Item -LiteralPath $stateTemp -Destination $statePath -Force
    Wait-Health $Definition
    $listener = Get-PortOwner $Definition
    if (-not $listener -or [int]$listener.OwningProcess -ne [int]$started.Id) {
      throw "The healthy listener is not owned by the newly started PID $($started.Id)."
    }
  } catch {
    $failure = $_
    Remove-Item -LiteralPath $stateTemp -Force -ErrorAction SilentlyContinue
    if ($started) {
      $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($started.Id)" -ErrorAction SilentlyContinue
      $expectedModelPath = Get-ModelPath $Definition
      $candidateMatches = $candidate -and $candidate.ExecutablePath -and $candidate.CommandLine -and [IO.Path]::GetFullPath($candidate.ExecutablePath) -eq [IO.Path]::GetFullPath($serverExe) -and $candidate.CommandLine.Contains($expectedModelPath, [StringComparison]::OrdinalIgnoreCase) -and $candidate.CommandLine.Contains("--port $($Definition.port)", [StringComparison]::OrdinalIgnoreCase)
      if ($candidateMatches) {
        Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue
      }
      $state = Get-State $Definition
      if ($state -and [int]$state.processId -eq [int]$started.Id) {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
      }
    }
    throw $failure
  }
  Write-Host "$($Definition.alias) is healthy at http://127.0.0.1:$($Definition.port) (PID $($started.Id), $Mode)."
}

function Start-ModelByPolicy($Definition, [ValidateSet('auto', 'gpu', 'cpu')] [string]$Policy) {
  if ($Policy -eq 'cpu') { Start-Model $Definition cpu; return }
  if ($Policy -eq 'gpu') { Start-Model $Definition gpu; return }
  try {
    Start-Model $Definition gpu
  } catch {
    Write-Warning "$($Definition.alias) GPU startup failed in auto mode; retrying CPU: $($_.Exception.Message)"
    Start-Model $Definition cpu
  }
}

function Stop-Model($Definition) {
  $tracked = Get-TrackedProcess $Definition
  if (-not $tracked) { Remove-Item -LiteralPath (Get-StatePath $Definition) -Force -ErrorAction SilentlyContinue; return }
  $processId = [int]$tracked.ProcessId
  Stop-Process -Id $processId -ErrorAction SilentlyContinue
  $trackedProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($trackedProcess) { $trackedProcess.WaitForExit(10000) | Out-Null }
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { Stop-Process -Id $processId -Force }
  Remove-Item -LiteralPath (Get-StatePath $Definition) -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped $($Definition.alias) PID $processId."
}

function Invoke-EmbeddingSmoke($Definition) {
  $body = @{ model = $Definition.alias; input = @("Instruct: Given a news report, retrieve cross-language reports about the same event or continuing series.`nQuery: Alaska radar-site aircraft accident", '阿拉斯加雷达站附近发生飞机事故') }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($Definition.port)/v1/embeddings" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 180
  $watch.Stop()
  $dimensions = @($response.data[0].embedding).Count
  if ($dimensions -ne $Definition.dimensions) { throw "$($Definition.alias) returned $dimensions dimensions; expected $($Definition.dimensions)." }
  [ordered]@{ model = $Definition.alias; endpoint = '/v1/embeddings'; vectors = @($response.data).Count; dimensions = $dimensions; latencyMs = [math]::Round($watch.Elapsed.TotalMilliseconds, 1) }
}

function Invoke-RerankerSmoke($Definition) {
  $body = @{ model = $Definition.alias; query = '阿拉斯加雷达站附近的飞机事故'; top_n = 3; documents = @('Apple released an iPhone security update.', 'A charter plane crashed near a remote military radar site in Alaska, killing all eight aboard.', 'The central bank kept interest rates unchanged.') }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($Definition.port)/v1/rerank" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 5 -Compress) -TimeoutSec 180
  $watch.Stop()
  $results = if ($response.results) { @($response.results) } else { @($response) }
  if ($results.Count -lt 1 -or [int]$results[0].index -ne 1) { throw "$($Definition.alias) did not rank the matching document first." }
  [ordered]@{ model = $Definition.alias; endpoint = '/v1/rerank'; resultCount = $results.Count; firstDocumentIndex = [int]$results[0].index; latencyMs = [math]::Round($watch.Elapsed.TotalMilliseconds, 1) }
}

function Show-Status {
  @($definitions.Values | ForEach-Object {
    $definition = $_; $tracked = Get-TrackedProcess $definition; $state = Get-State $definition; $modelPath = Get-ModelPath $definition
    $item = Get-Item -LiteralPath $modelPath -ErrorAction SilentlyContinue
    [ordered]@{ key = $definition.key; model = $definition.alias; installed = $null -ne $item -and $item.Length -eq [long]$definition.bytes; bytes = if ($item) { $item.Length } else { 0 }; expectedBytes = $definition.bytes; modelPath = $modelPath; expectedSha256 = $definition.sha256; url = "http://127.0.0.1:$($definition.port)"; tracked = $null -ne $tracked; healthy = Test-Health $definition 2; processId = if ($tracked) { $tracked.ProcessId } else { $null }; mode = if ($state) { $state.mode } else { $null } }
  }) | ConvertTo-Json -Depth 5
}

function Show-Health($Definition) {
  if (-not (Test-Health $Definition 5)) { throw "http://127.0.0.1:$($Definition.port) is not healthy." }
  $models = Invoke-RestMethod -Uri "http://127.0.0.1:$($Definition.port)/v1/models" -TimeoutSec 10
  [ordered]@{
    model = $Definition.alias
    role = $Definition.role
    url = "http://127.0.0.1:$($Definition.port)"
    healthy = $true
    models = $models.data
  } | ConvertTo-Json -Depth 8
}

$mutating = $Action -in @('InstallCore', 'InstallCalibration', 'InstallAll', 'StartCore', 'StopCore', 'StartEmbedding', 'StartEmbeddingCpu', 'StopEmbedding', 'StartReranker', 'StartRerankerCpu', 'StopReranker', 'StartCalibration', 'StartCalibrationCpu', 'StartCalibrationGpu', 'StopCalibration', 'StopAll')
$serviceLock = $null
if ($mutating) {
  $serviceLock = [Threading.Mutex]::new($false, 'Local\KunpengReaderIntelligenceRetrieval')
  if (-not $serviceLock.WaitOne(0)) { throw 'Another retrieval model operation is already in progress.' }
}
try {
switch ($Action) {
  'InstallCore' { Install-Artifact $definitions.embedding06 | ConvertTo-Json; Install-Artifact $definitions.reranker06 | ConvertTo-Json }
  'InstallCalibration' { Install-Artifact $definitions.embedding8 | ConvertTo-Json }
  'InstallAll' { $definitions.Values | ForEach-Object { Install-Artifact $_ | ConvertTo-Json } }
  # Verify always recomputes the pinned SHA-256.  Phase transitions use the
  # smaller role-specific variants below so the editorial handoff never
  # needlessly reads the 8B calibration artifact from disk.
  'Verify' { $definitions.Values | ForEach-Object { Assert-Artifact $_ | ConvertTo-Json } }
  'VerifyCore' { @($definitions.embedding06, $definitions.reranker06) | ForEach-Object { Assert-Artifact $_ | ConvertTo-Json } }
  'VerifyCalibration' { Assert-Artifact $definitions.embedding8 | ConvertTo-Json }
  'StartCore' {
    $embeddingWasHealthy = Test-Health $definitions.embedding06 2
    Start-ModelByPolicy $definitions.embedding06 $DevicePolicy
    try { Start-ModelByPolicy $definitions.reranker06 $DevicePolicy }
    catch { if (-not $embeddingWasHealthy) { Stop-Model $definitions.embedding06 }; throw }
  }
  'StopCore' { Stop-Model $definitions.reranker06; Stop-Model $definitions.embedding06 }
  'StartEmbedding' { Start-ModelByPolicy $definitions.embedding06 $DevicePolicy }
  'StartEmbeddingCpu' { Start-Model $definitions.embedding06 cpu }
  'StopEmbedding' { Stop-Model $definitions.embedding06 }
  'HealthEmbedding' { Show-Health $definitions.embedding06 }
  'StartReranker' { Start-ModelByPolicy $definitions.reranker06 $DevicePolicy }
  'StartRerankerCpu' { Start-Model $definitions.reranker06 cpu }
  'StopReranker' { Stop-Model $definitions.reranker06 }
  'HealthReranker' { Show-Health $definitions.reranker06 }
  'StartCalibration' { Start-ModelByPolicy $definitions.embedding8 $DevicePolicy }
  'StartCalibrationCpu' { Start-Model $definitions.embedding8 cpu }
  'StartCalibrationGpu' { Start-Model $definitions.embedding8 gpu }
  'StopCalibration' { Stop-Model $definitions.embedding8 }
  'HealthCalibration' { Show-Health $definitions.embedding8 }
  'StopAll' { Stop-Model $definitions.embedding8; Stop-Model $definitions.reranker06; Stop-Model $definitions.embedding06 }
  'Status' { Show-Status }
  'Smoke' {
    if (-not (Test-Health $definitions.embedding06 2)) { throw '0.6B embedding service is not healthy.' }
    Invoke-EmbeddingSmoke $definitions.embedding06 | ConvertTo-Json
    if (-not (Test-Health $definitions.reranker06 2)) { throw '0.6B reranker service is not healthy.' }
    Invoke-RerankerSmoke $definitions.reranker06 | ConvertTo-Json
    if (Test-Health $definitions.embedding8 2) { Invoke-EmbeddingSmoke $definitions.embedding8 | ConvertTo-Json }
  }
}
} finally {
  if ($serviceLock) {
    $serviceLock.ReleaseMutex()
    $serviceLock.Dispose()
  }
}
