[CmdletBinding()]
param(
  [ValidateSet('TriageGpu', 'EditorialGpu', 'CalibrationCpu', 'CoreOnly', 'StopAll', 'Status')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$judge = Join-Path $scriptRoot 'local-intelligence-judge.ps1'
$retrieval = Join-Path $scriptRoot 'local-intelligence-retrieval-models.ps1'
$editor = Join-Path $scriptRoot 'local-intelligence-editor.ps1'
$runtimeStateDir = Join-Path (Join-Path $env:LOCALAPPDATA 'kunpeng-reader\local-llm\services') 'intelligence-runtime'
$runtimeStatePath = Join-Path $runtimeStateDir 'last-transition.json'
$script:transitionId = $null

foreach ($required in @($judge, $retrieval, $editor)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing runtime controller: $required"
  }
}

function Read-JsonCommand([string]$Script, [string]$ChildAction) {
  $raw = (& $Script -Action $ChildAction | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  $raw | ConvertFrom-Json
}

function Write-TransitionState(
  [string]$TargetPhase,
  [string]$Step,
  [ValidateSet('running', 'completed', 'failed')]
  [string]$Status,
  [double]$ElapsedMilliseconds = 0,
  [string]$FailureCode = $null
) {
  # This is deliberately an aggregate-only diagnostic record.  It never
  # contains article text, URLs, model paths, or child stderr; those can be
  # sensitive and are already available through each local service log.
  New-Item -ItemType Directory -Path $runtimeStateDir -Force | Out-Null
  $temporaryPath = "$runtimeStatePath.$PID.tmp"
  [ordered]@{
    transitionId = $script:transitionId
    targetPhase = $TargetPhase
    step = $Step
    status = $Status
    elapsedMilliseconds = [math]::Round($ElapsedMilliseconds, 1)
    failureCode = $FailureCode
    updatedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $runtimeStatePath -Force
}

function Get-TransitionFailureCode($ErrorRecord) {
  $message = [string]$ErrorRecord.Exception.Message
  if ($message -match '(?i)sha-256 mismatch|size mismatch|artifact is missing|not installed') { return 'artifact_validation_failed' }
  if ($message -match '(?i)free VRAM|physical VRAM') { return 'gpu_capacity_insufficient' }
  if ($message -match '(?i)GPU.*exclusive|conflicting.*PID') { return 'gpu_conflict' }
  if ($message -match '(?i)Target port|already owned') { return 'port_ownership_conflict' }
  if ($message -match '(?i)startup timed out|did not become healthy') { return 'service_start_timeout' }
  if ($message -match '(?i)postcondition failed') { return 'phase_health_postcondition_failed' }
  if ($message -match '(?i)mutex|already in progress') { return 'controller_busy' }
  return 'runtime_operation_failed'
}

function Get-TransitionState {
  if (-not (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf)) { return $null }
  try { Get-Content -LiteralPath $runtimeStatePath -Raw | ConvertFrom-Json } catch { $null }
}

function Invoke-RuntimeStep([string]$TargetPhase, [string]$Step, [string]$Script, [string]$ChildAction) {
  Write-TransitionState $TargetPhase $Step 'running'
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try {
    $null = & $Script -Action $ChildAction
    $watch.Stop()
    Write-TransitionState $TargetPhase $Step 'completed' $watch.Elapsed.TotalMilliseconds
  } catch {
    $watch.Stop()
    Write-TransitionState $TargetPhase $Step 'failed' $watch.Elapsed.TotalMilliseconds (Get-TransitionFailureCode $_)
    throw
  }
}

function Get-RuntimeSnapshot {
  $judgeStatus = Read-JsonCommand $judge 'Status'
  $retrievalStatus = @(Read-JsonCommand $retrieval 'Status')
  $editorStatus = Read-JsonCommand $editor 'Status'
  $embedding = $retrievalStatus | Where-Object key -eq 'embedding06' | Select-Object -First 1
  $reranker = $retrievalStatus | Where-Object key -eq 'reranker06' | Select-Object -First 1
  $calibration = $retrievalStatus | Where-Object key -eq 'embedding8' | Select-Object -First 1
  $coreHealthy = $embedding.healthy -eq $true -and $reranker.healthy -eq $true
  $judgeHealthy = $judgeStatus.healthy -eq $true
  $editorHealthy = $editorStatus.healthy -eq $true
  $calibrationHealthy = $calibration.healthy -eq $true
  $phase = if ($judgeHealthy -and -not $editorHealthy -and $calibrationHealthy -and $coreHealthy) { 'TriageGpu' }
    elseif ($editorHealthy -and -not $judgeHealthy -and -not $calibrationHealthy -and $coreHealthy) { 'EditorialGpu' }
    elseif ($calibrationHealthy -and -not $judgeHealthy -and -not $editorHealthy -and $coreHealthy) { 'CalibrationCpu' }
    elseif ($coreHealthy -and -not $judgeHealthy -and -not $editorHealthy -and -not $calibrationHealthy) { 'CoreOnly' }
    elseif ($judgeStatus.healthy -eq $true -or $editorStatus.healthy -eq $true -or $calibration.healthy -eq $true) { 'Partial' }
    else { 'Stopped' }
  [ordered]@{
    phase = $phase
    healthy = $phase -in @('TriageGpu', 'EditorialGpu', 'CalibrationCpu', 'CoreOnly')
    lastTransition = Get-TransitionState
    judge = $judgeStatus
    retrieval = $retrievalStatus
    editor = $editorStatus
  }
}

function Assert-TargetPortsAvailable([string]$TargetPhase) {
  $snapshot = Get-RuntimeSnapshot
  $trackedByPort = @{}
  if ($snapshot.judge.tracked -eq $true) { $trackedByPort['8081'] = [int]$snapshot.judge.processId }
  if ($snapshot.editor.tracked -eq $true) { $trackedByPort['8080'] = [int]$snapshot.editor.processId }
  foreach ($item in @($snapshot.retrieval)) {
    if ($item.tracked -eq $true) {
      $uri = [Uri]$item.url
      $trackedByPort[[string]$uri.Port] = [int]$item.processId
    }
  }
  $ports = switch ($TargetPhase) {
    'TriageGpu' { @(8081, 8082, 8083, 8084) }
    'EditorialGpu' { @(8080, 8082, 8083) }
    'CalibrationCpu' { @(8082, 8083, 8084) }
    'CoreOnly' { @(8082, 8083) }
    default { @() }
  }
  foreach ($port in $ports) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener -and (-not $trackedByPort.ContainsKey([string]$port) -or [int]$listener.OwningProcess -ne [int]$trackedByPort[[string]$port])) {
      throw "Target port $port is owned by untracked PID $($listener.OwningProcess); refusing to replace it."
    }
  }
}

function Invoke-Preflight([string]$TargetPhase) {
  if ($TargetPhase -eq 'StopAll') { return }
  # Each listed action recomputes the pinned SHA-256 before we stop a healthy
  # phase.  Do not replace this with a size-only cache: it would turn a
  # corrupt artifact into a disruptive partial switch.
  switch ($TargetPhase) {
    'TriageGpu' {
      Invoke-RuntimeStep $TargetPhase 'verify_core_retrieval' $retrieval 'VerifyCore'
      Invoke-RuntimeStep $TargetPhase 'verify_calibration_retrieval' $retrieval 'VerifyCalibration'
      Invoke-RuntimeStep $TargetPhase 'verify_8b_judge' $judge 'Verify'
    }
    'EditorialGpu' {
      Invoke-RuntimeStep $TargetPhase 'verify_core_retrieval' $retrieval 'VerifyCore'
      Invoke-RuntimeStep $TargetPhase 'verify_27b_editor' $editor 'Verify'
    }
    'CalibrationCpu' {
      Invoke-RuntimeStep $TargetPhase 'verify_core_retrieval' $retrieval 'VerifyCore'
      Invoke-RuntimeStep $TargetPhase 'verify_calibration_retrieval' $retrieval 'VerifyCalibration'
    }
    'CoreOnly' { Invoke-RuntimeStep $TargetPhase 'verify_core_retrieval' $retrieval 'VerifyCore' }
    default { throw "Cannot preflight unknown runtime phase: $TargetPhase" }
  }
  Assert-TargetPortsAvailable $TargetPhase
}

function Set-RuntimePhaseUnsafe([string]$TargetPhase) {
  switch ($TargetPhase) {
    'TriageGpu' {
      Invoke-RuntimeStep $TargetPhase 'stop_27b_editor' $editor 'Stop'
      Invoke-RuntimeStep $TargetPhase 'start_core_retrieval' $retrieval 'StartCore'
      # The high-precision 8B embedding calibrator is CPU-only in this phase,
      # so boundary-pair calibration remains available while the 8B text judge
      # owns the GPU. It is stopped before 27B editorial loading.
      Invoke-RuntimeStep $TargetPhase 'start_calibration_cpu' $retrieval 'StartCalibrationCpu'
      Invoke-RuntimeStep $TargetPhase 'start_8b_judge_gpu' $judge 'StartGpu'
    }
    'EditorialGpu' {
      Invoke-RuntimeStep $TargetPhase 'stop_8b_judge' $judge 'Stop'
      Invoke-RuntimeStep $TargetPhase 'stop_calibration' $retrieval 'StopCalibration'
      Invoke-RuntimeStep $TargetPhase 'start_core_retrieval' $retrieval 'StartCore'
      Invoke-RuntimeStep $TargetPhase 'start_27b_editor_gpu' $editor 'StartGpu'
    }
    'CalibrationCpu' {
      # This phase is deterministic regardless of the preceding phase: no
      # GPU text model remains loaded while the 8B embedding service runs.
      Invoke-RuntimeStep $TargetPhase 'stop_8b_judge' $judge 'Stop'
      Invoke-RuntimeStep $TargetPhase 'stop_27b_editor' $editor 'Stop'
      Invoke-RuntimeStep $TargetPhase 'start_core_retrieval' $retrieval 'StartCore'
      Invoke-RuntimeStep $TargetPhase 'start_calibration_cpu' $retrieval 'StartCalibrationCpu'
    }
    'CoreOnly' {
      Invoke-RuntimeStep $TargetPhase 'stop_8b_judge' $judge 'Stop'
      Invoke-RuntimeStep $TargetPhase 'stop_27b_editor' $editor 'Stop'
      Invoke-RuntimeStep $TargetPhase 'stop_calibration' $retrieval 'StopCalibration'
      Invoke-RuntimeStep $TargetPhase 'start_core_retrieval' $retrieval 'StartCore'
    }
    'StopAll' {
      Invoke-RuntimeStep $TargetPhase 'stop_8b_judge' $judge 'Stop'
      Invoke-RuntimeStep $TargetPhase 'stop_27b_editor' $editor 'Stop'
      Invoke-RuntimeStep $TargetPhase 'stop_retrieval' $retrieval 'StopAll'
    }
    'Stopped' {
      Invoke-RuntimeStep $TargetPhase 'stop_8b_judge' $judge 'Stop'
      Invoke-RuntimeStep $TargetPhase 'stop_27b_editor' $editor 'Stop'
      Invoke-RuntimeStep $TargetPhase 'stop_retrieval' $retrieval 'StopAll'
    }
    default { throw "Cannot establish unknown runtime phase: $TargetPhase" }
  }
}

function Restore-PreviousPhase([string]$PreviousPhase) {
  $restore = if ($PreviousPhase -in @('TriageGpu', 'EditorialGpu', 'CalibrationCpu', 'CoreOnly', 'Stopped')) {
    $PreviousPhase
  } else {
    'CoreOnly'
  }
  Set-RuntimePhaseUnsafe $restore
}

function Switch-RuntimePhase([string]$TargetPhase) {
  $script:transitionId = [Guid]::NewGuid().ToString('N')
  $before = Get-RuntimeSnapshot
  if ($before.phase -eq $TargetPhase -and $before.healthy) { return $before }
  Write-TransitionState $TargetPhase 'preflight' 'running'
  try {
    Invoke-Preflight $TargetPhase
    Write-TransitionState $TargetPhase 'apply_phase' 'running'
    Set-RuntimePhaseUnsafe $TargetPhase
    Write-TransitionState $TargetPhase 'verify_phase_health' 'running'
    $after = Get-RuntimeSnapshot
    if ($TargetPhase -eq 'StopAll') {
      if ($after.phase -ne 'Stopped') { throw "StopAll left runtime in phase $($after.phase)." }
    } elseif ($after.phase -ne $TargetPhase -or -not $after.healthy) {
      throw "Runtime postcondition failed: expected $TargetPhase, got $($after.phase)."
    }
    Write-TransitionState $TargetPhase 'verify_phase_health' 'completed'
    return $after
  } catch {
    Write-TransitionState $TargetPhase 'rollback' 'running'
    $switchFailure = $_
    try {
      Restore-PreviousPhase $before.phase
      Write-TransitionState $TargetPhase 'rollback' 'completed'
    } catch {
      $rollbackFailure = $_
      Write-TransitionState $TargetPhase 'rollback' 'failed' 0 (Get-TransitionFailureCode $_)
      throw "Switch to $TargetPhase failed: $switchFailure Rollback to $($before.phase) also failed: $rollbackFailure"
    }
    Write-TransitionState $TargetPhase 'apply_phase' 'failed' 0 (Get-TransitionFailureCode $switchFailure)
    throw "Switch to $TargetPhase failed and the previous $($before.phase) phase was restored: $switchFailure"
  }
}

$mutating = $Action -ne 'Status'
$runtimeLock = $null
if ($mutating) {
  $runtimeLock = [Threading.Mutex]::new($false, 'Local\KunpengReaderIntelligenceRuntime')
  if (-not $runtimeLock.WaitOne(0)) { throw 'Another intelligence runtime phase switch is already in progress.' }
}
try {
  if ($Action -eq 'Status') {
    Get-RuntimeSnapshot | ConvertTo-Json -Depth 10
  } else {
    Switch-RuntimePhase $Action | ConvertTo-Json -Depth 10
  }
} finally {
  if ($runtimeLock) {
    $runtimeLock.ReleaseMutex()
    $runtimeLock.Dispose()
  }
}
