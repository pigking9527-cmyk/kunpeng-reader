[CmdletBinding()]
param(
  [ValidateSet('Install', 'Verify', 'StartCpu', 'StartGpu', 'Stop', 'Status', 'Health', 'Benchmark')]
  [string]$Action = 'Status',
  [ValidateRange(1024, 32768)]
  [int]$ContextSize = 8192,
  [ValidateRange(1, 20)]
  [int]$BenchmarkRuns = 6
)

$ErrorActionPreference = 'Stop'

$modelName = 'Qwen3-8B-Q4_K_M'
$modelRevision = '212c964b8f97cb5edc203d411b767aaae707e653'
$modelSha256 = 'D98CDCBD03E17CE47681435B5150E34C1417F50B5C0019DD560E4882C5745785'
$modelSize = 5027783488L
$runtimeSha256 = 'C8B1E5A66E1BB45854BED3DAAAB116C37E74526E30143D737C67557BAB822359'
$modelUrl = "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/$modelRevision/Qwen3-8B-Q4_K_M.gguf?download=true"
$port = 8081

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is unavailable; the local model must stay outside the repository.'
}

$localRoot = Join-Path $env:LOCALAPPDATA 'kunpeng-reader\local-llm'
$runtimeDir = Join-Path $localRoot 'llama-b10549'
$serverExe = Join-Path $runtimeDir 'llama-server.exe'
$modelDir = Join-Path $localRoot "models\$modelName"
$modelPath = Join-Path $modelDir "$modelName.gguf"
$stateDir = Join-Path $localRoot 'services\intelligence-judge-8b'
$pidFile = Join-Path $stateDir 'server-state.json'
$stdoutLog = Join-Path $stateDir 'server-stdout.log'
$stderrLog = Join-Path $stateDir 'server-stderr.log'
$baseUrl = "http://127.0.0.1:$port"

function Resolve-NormalizedPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-ModelArtifact {
  if (-not (Test-Path -LiteralPath $serverExe -PathType Leaf)) {
    throw "llama-server.exe was not found: $serverExe"
  }
  $runtimeHash = (Get-FileHash -LiteralPath $serverExe -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($runtimeHash -ne $runtimeSha256) {
    throw "llama-server.exe SHA-256 mismatch: expected $runtimeSha256, got $runtimeHash."
  }
  if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) {
    throw "Model is not installed. Run: scripts/local-intelligence-judge.ps1 -Action Install"
  }

  $item = Get-Item -LiteralPath $modelPath
  if ($item.Length -ne $modelSize) {
    throw "Model size mismatch: expected $modelSize bytes, got $($item.Length)."
  }

  $actualHash = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualHash -ne $modelSha256) {
    throw "Model SHA-256 mismatch: expected $modelSha256, got $actualHash."
  }

  return [pscustomobject]@{
    model = $modelName
    path = $modelPath
    bytes = $item.Length
    sha256 = $actualHash
    revision = $modelRevision
    license = 'Apache-2.0'
  }
}

function Install-ModelArtifact {
  New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
  if (Test-Path -LiteralPath $modelPath -PathType Leaf) {
    $existing = Get-Item -LiteralPath $modelPath
    if ($existing.Length -eq $modelSize) {
      return Assert-ModelArtifact
    }
    if ($existing.Length -gt $modelSize) {
      throw "Model is larger than the pinned artifact: expected $modelSize bytes, got $($existing.Length)."
    }
    Write-Host "Resuming $modelName at $($existing.Length) of $modelSize bytes."
  }

  $aria2 = Get-Command aria2c.exe -ErrorAction SilentlyContinue
  if ($aria2) {
    & $aria2.Source `
      '--continue=true' `
      '--max-connection-per-server=16' `
      '--split=16' `
      '--min-split-size=4M' `
      '--file-allocation=none' `
      '--auto-file-renaming=false' `
      '--allow-overwrite=false' `
      '--check-certificate=true' `
      "--dir=$modelDir" `
      "--out=$modelName.gguf" `
      $modelUrl
    if ($LASTEXITCODE -ne 0) {
      throw "aria2c failed with exit code $LASTEXITCODE."
    }
  } else {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) {
      throw 'Neither aria2c.exe nor curl.exe is available.'
    }
    & $curl.Source '--fail' '--location' '--continue-at' '-' '--output' $modelPath $modelUrl
    if ($LASTEXITCODE -ne 0) {
      throw "curl failed with exit code $LASTEXITCODE."
    }
  }

  return Assert-ModelArtifact
}

function Get-StateRecord {
  if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-TrackedProcess {
  $state = Get-StateRecord
  if (-not $state -or -not $state.processId) {
    return $null
  }

  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.processId)" -ErrorAction SilentlyContinue
  if (-not $processInfo -or -not $processInfo.ExecutablePath -or -not $processInfo.CommandLine) {
    return $null
  }

  $expectedExe = Resolve-NormalizedPath $serverExe
  $actualExe = Resolve-NormalizedPath $processInfo.ExecutablePath
  if ($actualExe -ne $expectedExe) {
    return $null
  }
  if (-not $processInfo.CommandLine.Contains($modelPath, [StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  if (-not $processInfo.CommandLine.Contains("--port $port", [StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }

  return $processInfo
}

function Get-PortOwner {
  try {
    return Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop |
      Select-Object -First 1
  } catch {
    return $null
  }
}

function Test-Health([int]$TimeoutSeconds = 2) {
  try {
    $tracked = Get-TrackedProcess
    $listener = Get-PortOwner
    if (-not $tracked -or -not $listener -or [int]$tracked.ProcessId -ne [int]$listener.OwningProcess) { return $false }
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/health" -TimeoutSec $TimeoutSeconds
    if ($response.StatusCode -ne 200) { return $false }
    $models = Invoke-RestMethod -Uri "$baseUrl/v1/models" -TimeoutSec $TimeoutSeconds
    return @($models.data | ForEach-Object { [string]$_.id }) -contains $modelName
  } catch {
    return $false
  }
}

function Wait-Health([int]$TimeoutSeconds = 240) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $tracked = Get-TrackedProcess
    if (-not $tracked) {
      $tail = if (Test-Path -LiteralPath $stderrLog) {
        (Get-Content -LiteralPath $stderrLog -Tail 20) -join [Environment]::NewLine
      } else {
        'No stderr log was produced.'
      }
      throw "The local judge server exited during startup.`n$tail"
    }
    if (Test-Health -TimeoutSeconds 2) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "The local judge server did not become healthy within $TimeoutSeconds seconds."
}

function Assert-GpuBacklogCanStart {
  $conflicts = Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $commandLine = [string]$_.CommandLine
      $commandLine.Contains('--device CUDA0', [StringComparison]::OrdinalIgnoreCase) -or
      $commandLine.Contains('--gpu-layers all', [StringComparison]::OrdinalIgnoreCase) -or
      $commandLine.Contains('Qwen3.8-27B-UD-Q3_K_XL', [StringComparison]::OrdinalIgnoreCase) -or
      $commandLine.Contains('Qwen3.5-27B-Q3_K_M', [StringComparison]::OrdinalIgnoreCase)
    }
  if ($conflicts) {
    $ids = ($conflicts | ForEach-Object ProcessId) -join ', '
    throw "GPU backlog mode is exclusive with every CUDA llama-server. Matching process IDs: $ids. Stop the conflicting service through its own controller, then retry."
  }
}

function Start-JudgeServer([ValidateSet('cpu', 'gpu')] [string]$Mode) {
  Assert-ModelArtifact | Out-Null
  if (-not (Test-Path -LiteralPath $serverExe -PathType Leaf)) {
    throw "llama-server.exe was not found: $serverExe"
  }

  $tracked = Get-TrackedProcess
  if ($tracked) {
    if (Test-Health -TimeoutSeconds 2) {
      Write-Host "Local judge server is already healthy (PID $($tracked.ProcessId))."
      return
    }
    throw "Tracked server PID $($tracked.ProcessId) exists but is unhealthy. Run -Action Stop before restarting."
  }

  $listener = Get-PortOwner
  if ($listener) {
    throw "127.0.0.1:$port is already owned by PID $($listener.OwningProcess); refusing to replace an untracked listener."
  }
  if ($Mode -eq 'gpu') {
    Assert-GpuBacklogCanStart
  }

  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

  $coreCount = [int](Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum
  if ($coreCount -lt 1) { $coreCount = 4 }
  $arguments = @(
    '--model', ('"' + $modelPath + '"'),
    '--alias', $modelName,
    '--host', '127.0.0.1',
    '--port', [string]$port,
    '--cors-origins', 'localhost',
    '--no-cors-credentials',
    '--ctx-size', [string]$ContextSize,
    '--threads', [string]$coreCount,
    '--threads-batch', [string]$coreCount,
    '--batch-size', '1024',
    '--ubatch-size', '256',
    '--parallel', '1',
    '--cont-batching',
    '--jinja',
    '--reasoning', 'off',
    '--reasoning-budget', '0',
    '--no-webui',
    '--metrics'
  )
  if ($Mode -eq 'cpu') {
    $arguments += @('--cache-type-k', 'q8_0', '--cache-type-v', 'f16', '--device', 'none', '--gpu-layers', '0', '--no-op-offload', '--flash-attn', 'off')
  } else {
    $arguments += @('--fit', 'off', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--device', 'CUDA0', '--gpu-layers', 'all', '--flash-attn', 'on')
  }

  $started = $null
  $stateTemp = "$pidFile.$PID.tmp"
  try {
    $started = Start-Process `
      -FilePath $serverExe `
      -WorkingDirectory $runtimeDir `
      -ArgumentList $arguments `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -WindowStyle Hidden `
      -PassThru

    [ordered]@{
      processId = $started.Id
      mode = $Mode
      model = $modelName
      modelPath = $modelPath
      runtimePath = $serverExe
      runtimeSha256 = $runtimeSha256
      host = '127.0.0.1'
      port = $port
      contextSize = $ContextSize
      startedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $stateTemp -Encoding UTF8
    Move-Item -LiteralPath $stateTemp -Destination $pidFile -Force
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
      $state = Get-StateRecord
      if ($state -and [int]$state.processId -eq [int]$started.Id) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      }
    }
    throw $failure
  }
  Write-Host "Local judge server is healthy at $baseUrl/v1 (PID $($started.Id), mode $Mode)."
}

function Stop-JudgeServer {
  $tracked = Get-TrackedProcess
  if (-not $tracked) {
    Write-Host 'No matching tracked judge process is running.'
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    return
  }

  $processId = [int]$tracked.ProcessId
  Stop-Process -Id $processId -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    Stop-Process -Id $processId -Force
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped the tracked local judge process (PID $processId)."
}

function Get-ResourceSnapshot([int]$ProcessId) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  $operatingSystem = Get-CimInstance Win32_OperatingSystem
  $gpuMiB = $null
  $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($nvidiaSmi) {
    $rows = & $nvidiaSmi.Source '--query-compute-apps=pid,used_memory' '--format=csv,noheader,nounits' 2>$null
    foreach ($row in $rows) {
      if ($row -match '^\s*(\d+)\s*,\s*(\d+|N/A)') {
        if ([int]$Matches[1] -eq $ProcessId -and $Matches[2] -ne 'N/A') {
          $gpuMiB = [int]$Matches[2]
        }
      }
    }
  }
  return [ordered]@{
    workingSetMiB = if ($process) { [math]::Round($process.WorkingSet64 / 1MB, 1) } else { $null }
    privateMemoryMiB = if ($process) { [math]::Round($process.PrivateMemorySize64 / 1MB, 1) } else { $null }
    gpuMemoryMiB = $gpuMiB
    systemFreeMemoryMiB = [math]::Round([double]$operatingSystem.FreePhysicalMemory / 1KB, 1)
  }
}

function Invoke-Benchmark {
  if (-not (Test-Health -TimeoutSeconds 2)) {
    throw 'The local judge server is not healthy. Start it before benchmarking.'
  }
  $tracked = Get-TrackedProcess
  if (-not $tracked) {
    throw 'The healthy listener is not the tracked local judge process.'
  }

  $cases = @(
    [ordered]@{
      expected = 'same_event'
      text = 'A (source=Associated Press, language=en): Alaska charter plane crashes near a remote military radar site, killing all eight aboard. B (source=新华社, language=zh): 阿拉斯加偏远雷达站附近一架包机坠毁，机上8人全部遇难。 The publishers and URLs are independent.'
    },
    [ordered]@{
      expected = 'exact_duplicate'
      text = 'A: 科沃斯上半年归母净利润12.48亿元，同比增长27.4%。 B: 科沃斯上半年归母净利润12.48亿元，同比增长27.4%。'
    },
    [ordered]@{
      expected = 'syndicated_copy'
      text = 'A: Reuters: Acme reported quarterly revenue of $4.2 billion on Tuesday. B: Market Daily republishes Reuters: Acme reported quarterly revenue of $4.2 billion on Tuesday.'
    },
    [ordered]@{
      expected = 'event_update'
      text = 'A: Rescuers are searching for eight people after a charter plane disappeared near an Alaska radar site. B: Officials later confirmed that the wreckage was found and all eight people aboard died.'
    },
    [ordered]@{
      expected = 'same_series'
      text = 'A: Central bank raises rates by 25 basis points in May. B: Central bank signals that another rate decision will be announced in June.'
    },
    [ordered]@{
      expected = 'correction'
      text = 'A: Initial report says nine people died in the accident. B: Police correct the toll to eight and say the ninth person survived.'
    },
    [ordered]@{
      expected = 'background'
      text = 'A: Government announces a new round of semiconductor export controls today. B: Explainer: how the export-control framework has evolved since 2022.'
    },
    [ordered]@{
      expected = 'unrelated'
      text = 'A: Apple releases a security update for iPhone. B: Apple growers in Washington report a larger fruit harvest.'
    }
  )
  if ($BenchmarkRuns -lt $cases.Count) {
    $cases = @($cases | Select-Object -First $BenchmarkRuns)
  } elseif ($BenchmarkRuns -gt $cases.Count) {
    $expanded = @()
    for ($index = 0; $index -lt $BenchmarkRuns; $index++) {
      $expanded += $cases[$index % $cases.Count]
    }
    $cases = $expanded
  }

  $schema = [ordered]@{
    type = 'object'
    additionalProperties = $false
    required = @('important', 'importance', 'relation', 'confidence', 'reason')
    properties = [ordered]@{
      important = @{ type = 'boolean' }
      importance = @{ type = 'integer'; minimum = 0; maximum = 100 }
      relation = @{ type = 'string'; enum = @('exact_duplicate', 'syndicated_copy', 'same_event', 'event_update', 'same_series', 'background', 'correction', 'unrelated') }
      confidence = @{ type = 'number'; minimum = 0; maximum = 1 }
      reason = @{ type = 'string'; maxLength = 160 }
    }
  }
  $results = @()
  $totalPredictedTokens = 0.0
  $totalPredictedMs = 0.0

  for ($index = 0; $index -lt $cases.Count; $index++) {
    $case = $cases[$index]
    $body = [ordered]@{
      model = $modelName
      temperature = 0
      max_tokens = 160
      stream = $false
      messages = @(
        @{ role = 'system'; content = 'You classify public news. Compare A and B and return only the requested JSON. Apply this decision order: (1) exact_duplicate only for the same document after trivial normalization; if A and B use different languages, exact_duplicate is not allowed unless the input explicitly says they are two copies of the same translated document. A translation or independent report of equal facts is normally same_event. (2) syndicated_copy only when one source republishes the same wire/article copy. (3) correction when a later source corrects a prior factual claim. (4) event_update only when B gives a later outcome of the very same occurrence, such as search then rescue result. (5) same_event for independent reports of one occurrence, including cross-language reports. (6) background when one item supplies older history or an explainer directly contextualizing the current event. (7) same_series for distinct occurrences or scheduled decisions in the same named continuing story, policy, case, conflict, or organization; separate monthly rate decisions are same_series, not event_update. (8) unrelated. Shared topic or entity alone is insufficient. Use dates, actors, action, place, numbers, source identity, and temporal direction.' },
        @{ role = 'user'; content = $case.text }
      )
      response_format = @{
        type = 'json_schema'
        json_schema = @{ name = 'news_relation'; strict = $true; schema = $schema }
      }
      chat_template_kwargs = @{ enable_thinking = $false }
    }

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-RestMethod `
      -Method Post `
      -Uri "$baseUrl/v1/chat/completions" `
      -ContentType 'application/json; charset=utf-8' `
      -Body ($body | ConvertTo-Json -Depth 12 -Compress) `
      -TimeoutSec 180
    $stopwatch.Stop()

    $content = [string]$response.choices[0].message.content
    $validJson = $false
    $relation = $null
    try {
      $parsed = $content | ConvertFrom-Json
      $validJson = $null -ne $parsed.important -and
        $null -ne $parsed.importance -and
        $null -ne $parsed.relation -and
        $null -ne $parsed.confidence -and
        -not [string]::IsNullOrWhiteSpace([string]$parsed.reason)
      $relation = [string]$parsed.relation
    } catch {
      $validJson = $false
    }

    $predictedTokens = if ($response.timings -and $response.timings.predicted_n) {
      [double]$response.timings.predicted_n
    } elseif ($response.usage -and $response.usage.completion_tokens) {
      [double]$response.usage.completion_tokens
    } else { 0.0 }
    $predictedMs = if ($response.timings -and $response.timings.predicted_ms) {
      [double]$response.timings.predicted_ms
    } else { 0.0 }
    $totalPredictedTokens += $predictedTokens
    $totalPredictedMs += $predictedMs

    $results += [ordered]@{
      case = $index + 1
      expectedRelation = $case.expected
      relation = $relation
      relationMatch = $relation -eq $case.expected
      jsonValid = $validJson
      latencyMs = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 1)
      promptTokens = if ($response.usage) { $response.usage.prompt_tokens } else { $null }
      completionTokens = if ($response.usage) { $response.usage.completion_tokens } else { $null }
      predictedTokensPerSecond = if ($response.timings) { $response.timings.predicted_per_second } else { $null }
    }
  }

  $validCount = @($results | Where-Object jsonValid).Count
  $matchCount = @($results | Where-Object relationMatch).Count
  $latencies = @($results | ForEach-Object { [double]$_.latencyMs } | Sort-Object)
  $p95Index = [math]::Min($latencies.Count - 1, [math]::Ceiling($latencies.Count * 0.95) - 1)
  $state = Get-StateRecord
  $report = [ordered]@{
    schemaVersion = 1
    measuredAt = [DateTime]::UtcNow.ToString('o')
    model = $modelName
    modelSha256 = $modelSha256
    mode = if ($state) { $state.mode } else { 'unknown' }
    contextSize = if ($state) { $state.contextSize } else { $ContextSize }
    runs = $results.Count
    jsonComplianceRate = [math]::Round($validCount / [double]$results.Count, 4)
    relationMatchRate = [math]::Round($matchCount / [double]$results.Count, 4)
    averageLatencyMs = [math]::Round(($latencies | Measure-Object -Average).Average, 1)
    p95LatencyMs = [math]::Round($latencies[$p95Index], 1)
    aggregatePredictedTokensPerSecond = if ($totalPredictedMs -gt 0) {
      [math]::Round($totalPredictedTokens / ($totalPredictedMs / 1000.0), 2)
    } else { $null }
    resources = Get-ResourceSnapshot -ProcessId ([int]$tracked.ProcessId)
    cases = $results
  }
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  $reportPath = Join-Path $stateDir ("benchmark-{0}-{1}.json" -f $report.mode, [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  $report | ConvertTo-Json -Depth 10
  Write-Host "Benchmark report: $reportPath"
}

function Show-Status {
  $state = Get-StateRecord
  $tracked = Get-TrackedProcess
  $listener = Get-PortOwner
  $modelItem = Get-Item -LiteralPath $modelPath -ErrorAction SilentlyContinue
  [ordered]@{
    installed = $null -ne $modelItem -and $modelItem.Length -eq $modelSize
    bytes = if ($modelItem) { $modelItem.Length } else { 0 }
    expectedBytes = $modelSize
    model = $modelName
    modelPath = $modelPath
    expectedSha256 = $modelSha256
    serviceBaseUrl = "$baseUrl/v1"
    tracked = $null -ne $tracked
    healthy = Test-Health -TimeoutSeconds 2
    processId = if ($tracked) { $tracked.ProcessId } else { $null }
    mode = if ($state) { $state.mode } else { $null }
    listenerProcessId = if ($listener) { $listener.OwningProcess } else { $null }
    resources = if ($tracked) { Get-ResourceSnapshot -ProcessId ([int]$tracked.ProcessId) } else { $null }
  } | ConvertTo-Json -Depth 6
}

$mutating = $Action -in @('Install', 'StartCpu', 'StartGpu', 'Stop')
$serviceLock = $null
if ($mutating) {
  $serviceLock = [Threading.Mutex]::new($false, 'Local\KunpengReaderIntelligenceJudge8B')
  if (-not $serviceLock.WaitOne(0)) { throw 'Another 8B judge operation is already in progress.' }
}
try {
switch ($Action) {
  'Install' { Install-ModelArtifact | ConvertTo-Json -Depth 4 }
  'Verify' { Assert-ModelArtifact | ConvertTo-Json -Depth 4 }
  'StartCpu' { Start-JudgeServer -Mode cpu }
  'StartGpu' { Start-JudgeServer -Mode gpu }
  'Stop' { Stop-JudgeServer }
  'Status' { Show-Status }
  'Health' {
    if (-not (Test-Health -TimeoutSeconds 5)) { throw "$baseUrl is not healthy." }
    Invoke-RestMethod -Uri "$baseUrl/v1/models" -TimeoutSec 10 | ConvertTo-Json -Depth 8
  }
  'Benchmark' { Invoke-Benchmark }
}
} finally {
  if ($serviceLock) {
    $serviceLock.ReleaseMutex()
    $serviceLock.Dispose()
  }
}
