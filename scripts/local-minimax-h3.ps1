[CmdletBinding()]
param(
  [ValidateSet('Status', 'Prepare', 'InstallAsync', 'InstallWorker', 'Start', 'Stop', 'ConfigureComfyUi')]
  [string]$Action = 'Status',
  [string]$ComfyUiRoot = '',
  [string]$WorkflowPath = '',
  [string]$PythonPath = '',
  [string]$Endpoint = 'http://127.0.0.1:8188',
  [string]$InstallRoot = ''
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeScript = Join-Path $scriptRoot 'local-minimax-h3-server.py'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'kunpeng-reader\local-llm\minimax-h3'
$configPath = Join-Path $runtimeRoot 'comfyui-config.json'
$bridgeStatePath = Join-Path $runtimeRoot 'bridge-state.json'
$comfyStatePath = Join-Path $runtimeRoot 'comfyui-state.json'
$installStatePath = Join-Path $runtimeRoot 'install-state.json'
$logRoot = Join-Path $runtimeRoot 'logs'
$outputRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ebook-reader\reader-media'

# The managed ComfyUI/GGUF route targets a 16 GiB-class card and 32 GiB system
# memory. The one-click path downloads the pinned runtime, nodes and selected
# local weights under the reader-media install directory; the reader and bridge
# speak only to loopback addresses. The manual configuration route remains for
# an existing, user-reviewed ComfyUI installation.
$requiredRamMiB = 28672
$requiredVramMiB = 15360
$bridgePort = 8095

New-Item -ItemType Directory -Force -Path $runtimeRoot, $logRoot, $outputRoot | Out-Null

function Write-InstallState([string]$State, [string]$Step, [string]$Message, [string]$Root = '', [string]$Preset = '') {
  [ordered]@{
    state = $State
    step = $Step
    message = $Message
    installRoot = $Root
    preset = $Preset
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $installStatePath -Encoding UTF8
}

function Read-InstallState {
  if (-not (Test-Path -LiteralPath $installStatePath -PathType Leaf)) { return $null }
  try { Get-Content -LiteralPath $installStatePath -Raw | ConvertFrom-Json } catch { $null }
}

function Get-Hardware {
  $ramMiB = 0
  try { $ramMiB = [uint64][math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB) } catch {}
  $gpuName = ''
  $vramMiB = 0
  try {
    $line = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
    if ($line -match '^(.*),\s*(\d+)\s*$') { $gpuName = $Matches[1].Trim(); $vramMiB = [uint64]$Matches[2] }
  } catch {}
  [pscustomobject]@{ ramMiB = $ramMiB; gpuName = $gpuName; vramMiB = $vramMiB; supported = $ramMiB -ge $requiredRamMiB -and $vramMiB -ge $requiredVramMiB }
}

function Get-RequiredDiskMiB($hardware) {
  if ($hardware.vramMiB -lt 24576) { return 49152 }
  if ($hardware.vramMiB -lt 32768) { return 53248 }
  return 61440
}

function Get-InstallStorage([string]$Root, [uint64]$RequiredMiB) {
  $candidate = if ($Root) { $Root } else { $PSScriptRoot }
  try {
    $full = [IO.Path]::GetFullPath($candidate)
    $driveName = [IO.Path]::GetPathRoot($full).TrimEnd('\\').TrimEnd(':')
    $freeMiB = [uint64][math]::Floor((Get-PSDrive -Name $driveName -ErrorAction Stop).Free / 1MB)
    return [pscustomobject]@{ availableMiB = $freeMiB; requiredMiB = $RequiredMiB; supported = $freeMiB -ge $RequiredMiB }
  } catch {
    return [pscustomobject]@{ availableMiB = [uint64]0; requiredMiB = $RequiredMiB; supported = $false }
  }
}

function Test-LoopbackEndpoint([string]$Value) {
  try { $uri = [uri]$Value } catch { return $false }
  if ($uri.Scheme -ne 'http' -or $uri.Port -lt 1 -or $uri.Port -gt 65535) { return $false }
  @('127.0.0.1', '::1', 'localhost').Contains($uri.Host.ToLowerInvariant())
}

function Read-Config {
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $null }
  try { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } catch { $null }
}

function Get-ConfiguredPython($config) {
  if ($config -and $config.pythonPath -and (Test-Path -LiteralPath $config.pythonPath -PathType Leaf)) { return [string]$config.pythonPath }
  if ($config -and $config.comfyUiRoot) {
    foreach ($candidate in @(
      (Join-Path $config.comfyUiRoot 'venv\Scripts\python.exe'),
      (Join-Path $config.comfyUiRoot 'python_embeded\python.exe'),
      (Join-Path $config.comfyUiRoot 'python_embedded\python.exe')
    )) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } }
  }
  return ''
}

function Test-WorkflowTemplate($config) {
  if (-not $config -or -not $config.workflowPath -or -not (Test-Path -LiteralPath $config.workflowPath -PathType Leaf)) { return $false }
  try {
    $raw = Get-Content -LiteralPath $config.workflowPath -Raw
    $null = $raw | ConvertFrom-Json
    return $raw.Contains('__KUNPENG_PROMPT__') -and $raw.Contains('__KUNPENG_OUTPUT_PREFIX__')
  } catch { return $false }
}

function Get-ModelArtifacts($config) {
  if (-not $config -or -not $config.comfyUiRoot -or -not (Test-Path -LiteralPath $config.comfyUiRoot -PathType Container)) { return @() }
  $models = Join-Path $config.comfyUiRoot 'models'
  if (-not (Test-Path -LiteralPath $models -PathType Container)) { return @() }
  @(Get-ChildItem -LiteralPath $models -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.safetensors','.gguf','.pt','.pth','.ckpt' -and $_.Name -match '(?i)minimax|h3' } |
    Select-Object -First 32)
}

function Test-ComfyHealth($config) {
  if (-not $config -or -not (Test-LoopbackEndpoint ([string]$config.endpoint))) { return $false }
  try { $null = Invoke-RestMethod -Uri "$($config.endpoint.TrimEnd('/'))/system_stats" -TimeoutSec 3 -NoProxy; return $true } catch { return $false }
}

function Read-StateProcess($path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try {
    $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $process = Get-Process -Id ([int]$state.processId) -ErrorAction Stop
    if ($state.executable -and $process.Path -ne [string]$state.executable) { return $null }
    if ($state.entry) {
      $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction Stop).CommandLine
      if (-not $commandLine -or -not $commandLine.Contains([string]$state.entry)) { return $null }
    }
    $process
  } catch { $null }
}

function Test-BridgeHealth {
  try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/health" -TimeoutSec 3 -NoProxy
    $result.model -eq 'MiniMaxAI/MiniMax-H3' -and $result.backend -eq 'comfyui'
  } catch { $false }
}

function Get-ConfigProblems($config) {
  $problems = [System.Collections.Generic.List[string]]::new()
  if (-not $config) { $problems.Add('尚未配置本机 ComfyUI/GGUF 运行环境'); return $problems }
  if (-not $config.comfyUiRoot -or -not (Test-Path -LiteralPath $config.comfyUiRoot -PathType Container)) { $problems.Add('ComfyUI 目录不存在') }
  elseif (-not (Test-Path -LiteralPath (Join-Path $config.comfyUiRoot 'main.py') -PathType Leaf)) { $problems.Add('选择的目录不是可启动的 ComfyUI（缺少 main.py）') }
  if (-not (Test-LoopbackEndpoint ([string]$config.endpoint))) { $problems.Add('ComfyUI 地址必须是本机回环 HTTP 地址') }
  if (-not (Test-WorkflowTemplate $config)) { $problems.Add('工作流必须是 API JSON，且包含 __KUNPENG_PROMPT__ 与 __KUNPENG_OUTPUT_PREFIX__ 占位符') }
  if (-not (Get-ConfiguredPython $config)) { $problems.Add('未找到 ComfyUI 专用 Python；请在配置中指定 python.exe') }
  $problems
}

function Get-Status {
  $hardware = Get-Hardware
  $config = Read-Config
  $install = Read-InstallState
  $requiredDiskMiB = Get-RequiredDiskMiB $hardware
  $diskRoot = if ($InstallRoot) { $InstallRoot } elseif ($config -and $config.installRoot) { [string]$config.installRoot } else { $PSScriptRoot }
  $storage = Get-InstallStorage $diskRoot $requiredDiskMiB
  $problems = @(Get-ConfigProblems $config)
  $artifacts = @(Get-ModelArtifacts $config)
  $modelReady = $problems.Count -eq 0 -and $artifacts.Count -gt 0
  $comfyReady = $modelReady -and (Test-ComfyHealth $config)
  $bridgeReady = Test-BridgeHealth
  $message = if ($install -and $install.state -in @('queued','running','failed')) {
    [string]$install.message
  } elseif (-not $hardware.supported -or -not $storage.supported) {
    "本机 $([math]::Round($hardware.ramMiB / 1024, 1)) GiB 内存 / $([math]::Round($hardware.vramMiB / 1024, 1)) GiB 显存 / $([math]::Round($storage.availableMiB / 1024, 1)) GiB 可用磁盘；ComfyUI/GGUF 路线至少需要 28 GiB 内存、15 GiB 显存和 $([math]::Round($storage.requiredMiB / 1024, 0)) GiB 磁盘空间。"
  } elseif ($problems.Count -gt 0) {
    "ComfyUI/GGUF 尚未就绪：$($problems -join '；')。点击一键配置 H3 会自动创建本地运行目录并安装所需组件。"
  } elseif ($artifacts.Count -eq 0) {
    '已连接本机 ComfyUI，但未在 models 目录发现名称含 MiniMax 或 H3 的量化权重。请按所选工作流安装并核验本地模型。'
  } elseif ($bridgeReady) {
    'MiniMax-H3 正通过本机 ComfyUI/GGUF 工作流运行；提示词、推理和生成文件均留在本机。'
  } elseif ($comfyReady) {
    'ComfyUI/GGUF 已就绪，尚未启动阅读器本地桥接服务。'
  } else {
    'ComfyUI/GGUF 配置与量化模型已检查；尚未启动或未通过 ComfyUI 本机健康检查。'
  }
  [ordered]@{
    configured = $problems.Count -eq 0
    modelReady = $modelReady
    runtimeReady = $bridgeReady
    hardwareSupported = $hardware.supported -and $storage.supported
    modelId = 'MiniMaxAI/MiniMax-H3'
    runtimeDevice = if ($bridgeReady) { 'ComfyUI + GGUF（本机 GPU）' } elseif ($hardware.supported) { 'ComfyUI/GGUF 待启动' } else { '未运行' }
    totalRamMib = $hardware.ramMiB
    requiredRamMib = $requiredRamMiB
    totalVramMib = $hardware.vramMiB
    requiredVramMib = $requiredVramMiB
    availableDiskMib = $storage.availableMiB
    requiredDiskMib = $storage.requiredMiB
    installationState = if ($install) { [string]$install.state } else { 'not_installed' }
    installationStep = if ($install) { [string]$install.step } else { '' }
    installationRoot = if ($install) { [string]$install.installRoot } elseif ($config -and $config.installRoot) { [string]$config.installRoot } else { '' }
    selectedPreset = if ($install -and $install.preset) { [string]$install.preset } elseif ($config -and $config.selectedPreset) { [string]$config.selectedPreset } else { '' }
    backend = 'comfyui'
    comfyUiReady = $comfyReady
    workflowReady = (Test-WorkflowTemplate $config)
    modelArtifactsReady = $artifacts.Count -gt 0
    message = $message
  }
}

function Assert-Hardware {
  $hardware = Get-Hardware
  if (-not $hardware.supported) { throw "ComfyUI/GGUF MiniMax-H3 至少需要 $requiredRamMiB MiB 内存和 $requiredVramMiB MiB 显存。" }
}

function Configure-ComfyUi {
  if (-not $ComfyUiRoot -or -not $WorkflowPath) { throw '需要选择已安装的 ComfyUI 根目录和 API 工作流 JSON；不会自动下载。' }
  $root = [IO.Path]::GetFullPath($ComfyUiRoot)
  $workflow = [IO.Path]::GetFullPath($WorkflowPath)
  $python = if ($PythonPath) { [IO.Path]::GetFullPath($PythonPath) } else { '' }
  $candidate = [pscustomobject]@{ schemaVersion = 1; comfyUiRoot = $root; workflowPath = $workflow; pythonPath = $python; endpoint = $Endpoint.TrimEnd('/') }
  $problems = @(Get-ConfigProblems $candidate)
  if ($problems.Count -gt 0) { throw "ComfyUI 配置无效：$($problems -join '；')" }
  $candidate | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
}

function Assert-SafeInstallRoot([string]$Value) {
  if (-not $Value) { throw '无法定位阅读器安装目录。' }
  $root = [IO.Path]::GetFullPath($Value)
  $driveRoot = [IO.Path]::GetPathRoot($root).TrimEnd('\\')
  if ($root.TrimEnd('\\') -eq $driveRoot -or (Split-Path -Leaf $root) -ne 'reader-media') {
    throw 'MiniMax-H3 只能安装到阅读器安装目录内的 reader-media 文件夹。'
  }
  return $root
}

function Get-H3Preset {
  $hardware = Get-Hardware
  if ($hardware.vramMiB -lt 15360) { throw 'MiniMax-H3 一键安装至少需要 15 GiB 显存。' }
  if ($hardware.vramMiB -lt 24576) {
    return [ordered]@{
      id = '16g-gguf-q3'
      label = '16GB 显存 · GGUF Q3 低显存'
      launchArgs = @('--lowvram')
      unetName = 'MiniMax-H3-FL2VA-Q3_K_M.gguf'
      unetUrl = 'https://huggingface.co/FenomAI/MiniMax-H3_GGUFs/resolve/main/MiniMax-H3-FL2VA-Q3_K_M.gguf?download=true'
      textName = 'qwen3vl-32B-MiniMax-H3-Q2_K.gguf'
      textUrl = 'https://huggingface.co/FenomAI/MiniMax-H3_GGUFs/resolve/main/qwen3vl-32B-MiniMax-H3-Q2_K.gguf?download=true'
      requiredDiskGiB = 48
    }
  }
  if ($hardware.vramMiB -lt 32768) {
    return [ordered]@{
      id = '24g-gguf-q4'
      label = '24GB 显存 · GGUF Q4 平衡'
      launchArgs = @('--normalvram')
      unetName = 'MiniMax-H3-FL2VA-Q4_K_M.gguf'
      unetUrl = 'https://huggingface.co/FenomAI/MiniMax-H3_GGUFs/resolve/main/MiniMax-H3-FL2VA-Q4_K_M.gguf?download=true'
      textName = 'qwen3vl-32B-MiniMax-H3-Q2_K.gguf'
      textUrl = 'https://huggingface.co/FenomAI/MiniMax-H3_GGUFs/resolve/main/qwen3vl-32B-MiniMax-H3-Q2_K.gguf?download=true'
      requiredDiskGiB = 52
    }
  }
  return [ordered]@{
    id = '32g-gguf-q4'
    label = '32GB+ 显存 · GGUF Q4 高质量'
    launchArgs = @('--normalvram')
    unetName = 'MiniMax-H3-FL2VA-Q4_K_M.gguf'
    unetUrl = 'https://huggingface.co/FenomAI/MiniMax-H3_GGUFs/resolve/main/MiniMax-H3-FL2VA-Q4_K_M.gguf?download=true'
    textName = 'qwen3vl-32B-MiniMax-H3-Q4_K_M.gguf'
    textUrl = 'https://huggingface.co/FenomAI/MiniMax-H3_GGUFs/resolve/main/qwen3vl-32B-MiniMax-H3-Q4_K_M.gguf?download=true'
    requiredDiskGiB = 60
  }
}

function Assert-InstallDisk([string]$Root, [int]$RequiredGiB) {
  $drive = [IO.Path]::GetPathRoot($Root).TrimEnd('\\').TrimEnd(':')
  $free = (Get-PSDrive -Name $drive -ErrorAction Stop).Free
  if ($free -lt ($RequiredGiB * 1GB)) {
    throw "安装目录所在磁盘可用空间不足：至少需要 $RequiredGiB GiB，当前只有 $([math]::Round($free / 1GB, 1)) GiB。"
  }
}

function Invoke-Download([string]$Url, [string]$Destination, [string]$Description) {
  if (Test-Path -LiteralPath $Destination -PathType Leaf) { return }
  $partial = "$Destination.part"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  & curl.exe --fail --location --retry 5 --retry-delay 3 --continue-at - --output $partial $Url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $partial -PathType Leaf)) {
    throw "$Description 下载失败；保留已下载部分，点击一键安装可继续。"
  }
  Move-Item -LiteralPath $partial -Destination $Destination -Force
}

function Expand-PortableComfyUi([string]$Archive, [string]$Root) {
  $comfyRoot = Join-Path $Root 'ComfyUI_windows_portable\ComfyUI'
  if (Test-Path -LiteralPath (Join-Path $comfyRoot 'main.py') -PathType Leaf) { return $comfyRoot }
  $sevenZip = @('7z.exe','7za.exe','7zr.exe') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
  if ($sevenZip) {
    & $sevenZip.Source x '-y' "-o$Root" $Archive | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'ComfyUI 安装包解压失败。' }
  } else {
    $bootstrap = Join-Path $Root 'bootstrap-python'
    $python = Join-Path $bootstrap 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
      & py.exe -3 -m venv $bootstrap
      if ($LASTEXITCODE -ne 0) { throw '无法建立解压所需的本地 Python 环境。' }
      & $python -m pip install --disable-pip-version-check --quiet py7zr
      if ($LASTEXITCODE -ne 0) { throw '无法安装本地 7z 解压组件。' }
    }
    & $python -c "import py7zr; py7zr.SevenZipFile(r'$Archive', mode='r').extractall(r'$Root')"
    if ($LASTEXITCODE -ne 0) { throw 'ComfyUI 安装包解压失败。' }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $comfyRoot 'main.py') -PathType Leaf)) {
    throw 'ComfyUI 安装包解压后未找到 main.py。'
  }
  return $comfyRoot
}

function Ensure-GitNode([string]$Url, [string]$Target) {
  if (Test-Path -LiteralPath (Join-Path $Target '.git') -PathType Container) { return }
  if (Test-Path -LiteralPath $Target) { throw "自定义节点目录已存在但不是受管理 Git 目录：$Target" }
  & git.exe clone --depth 1 $Url $Target
  if ($LASTEXITCODE -ne 0) { throw "无法安装 ComfyUI 节点：$Url" }
}

function Install-NodeRequirements([string]$Python, [string]$NodeRoot) {
  $requirements = Join-Path $NodeRoot 'requirements.txt'
  if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { return }
  & $Python -m pip install --disable-pip-version-check -r $requirements
  if ($LASTEXITCODE -ne 0) { throw "无法安装节点依赖：$requirements" }
}

function Write-ManagedWorkflow([string]$Path, $Preset) {
  $workflow = [ordered]@{
    '1' = [ordered]@{ class_type = 'UnetLoaderGGUF'; inputs = [ordered]@{ unet_name = $Preset.unetName } }
    '2' = [ordered]@{ class_type = 'CLIPLoaderGGUF'; inputs = [ordered]@{ clip_name = $Preset.textName; type = 'minimax'; device = 'default' } }
    '3' = [ordered]@{ class_type = 'VAELoader'; inputs = [ordered]@{ vae_name = 'minimax_h3_video_vae_fp16.safetensors' } }
    '4' = [ordered]@{ class_type = 'VAELoader'; inputs = [ordered]@{ vae_name = 'minimax_h3_audio_vae_fp32.safetensors' } }
    '5' = [ordered]@{ class_type = 'MiniMaxH3ImageToVideo'; inputs = [ordered]@{ clip = @('2',0); vae = @('3',0); width = 960; height = 544; length = 124; prompt = '__KUNPENG_PROMPT__' } }
    '6' = [ordered]@{ class_type = 'BasicGuider'; inputs = [ordered]@{ model = @('1',0); conditioning = @('5',0) } }
    '7' = [ordered]@{ class_type = 'KSamplerSelect'; inputs = [ordered]@{ sampler_name = 'euler' } }
    '8' = [ordered]@{ class_type = 'BasicScheduler'; inputs = [ordered]@{ model = @('1',0); scheduler = 'simple'; steps = 8; denoise = 1.0 } }
    '9' = [ordered]@{ class_type = 'RandomNoise'; inputs = [ordered]@{ noise_seed = 42 } }
    '10' = [ordered]@{ class_type = 'SamplerCustomAdvanced'; inputs = [ordered]@{ noise = @('9',0); guider = @('6',0); sampler = @('7',0); sigmas = @('8',0); latent_image = @('5',1) } }
    '11' = [ordered]@{ class_type = 'VAEDecode'; inputs = [ordered]@{ samples = @('10',0); vae = @('3',0) } }
    '12' = [ordered]@{ class_type = 'VAEDecodeAudio'; inputs = [ordered]@{ samples = @('10',1); vae = @('4',0) } }
    '13' = [ordered]@{ class_type = 'CreateVideo'; inputs = [ordered]@{ images = @('11',0); audio = @('12',0); fps = 24.0 } }
    '14' = [ordered]@{ class_type = 'SaveVideo'; inputs = [ordered]@{ video = @('13',0); filename_prefix = '__KUNPENG_OUTPUT_PREFIX__'; format = 'mp4'; codec = 'auto' } }
    '15' = [ordered]@{ class_type = 'SaveImage'; inputs = [ordered]@{ images = @('11',0); filename_prefix = '__KUNPENG_OUTPUT_PREFIX__' } }
  }
  $workflow | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Install-H3Worker([string]$Root) {
  $root = Assert-SafeInstallRoot $Root
  Assert-Hardware
  $preset = Get-H3Preset
  Assert-InstallDisk $root $preset.requiredDiskGiB
  try {
    Write-InstallState 'running' '准备目录' '正在创建阅读器本地 H3 工作目录…' $root $preset.label
    New-Item -ItemType Directory -Force -Path $root, (Join-Path $root 'downloads'), (Join-Path $root 'workflows') | Out-Null
    $archive = Join-Path $root 'downloads\ComfyUI_windows_portable_nvidia.7z'
    Write-InstallState 'running' '下载 ComfyUI' '正在下载官方 ComfyUI NVIDIA 便携运行环境…' $root $preset.label
    Invoke-Download 'https://github.com/Comfy-Org/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z' $archive '官方 ComfyUI 运行环境'
    Write-InstallState 'running' '部署 ComfyUI' '正在部署 ComfyUI 便携运行环境…' $root $preset.label
    $comfyRoot = Expand-PortableComfyUi $archive $root
    $python = Join-Path (Split-Path -Parent $comfyRoot) 'python_embeded\python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'ComfyUI 便携版缺少专用 Python。' }
    $nodesRoot = Join-Path $comfyRoot 'custom_nodes'
    Write-InstallState 'running' '安装 GGUF 节点' '正在安装 MiniMax-H3 所需的 GGUF 与工作流节点…' $root $preset.label
    $ggufNode = Join-Path $nodesRoot 'ComfyUI-GGUF'
    Ensure-GitNode 'https://github.com/city96/ComfyUI-GGUF.git' $ggufNode
    Install-NodeRequirements $python $ggufNode
    $h3Node = Join-Path $nodesRoot 'ComfyUI-H3-Multishot'
    Ensure-GitNode 'https://github.com/jlucasmcrell/ComfyUI-H3-Multishot.git' $h3Node
    Install-NodeRequirements $python $h3Node
    $patch = Join-Path $h3Node 'apply_gguf_arch_patch.py'
    if (Test-Path -LiteralPath $patch -PathType Leaf) {
      & $python $patch
      if ($LASTEXITCODE -ne 0) { throw 'MiniMax-H3 GGUF 架构补丁执行失败。' }
    }
    $models = Join-Path $comfyRoot 'models'
    Write-InstallState 'running' '下载 H3 量化模型' "正在下载自动选择的 $($preset.label) 模型；中断后可续传…" $root $preset.label
    Invoke-Download $preset.unetUrl (Join-Path $models "unet\$($preset.unetName)") 'MiniMax-H3 GGUF 主模型'
    Invoke-Download $preset.textUrl (Join-Path $models "text_encoders\$($preset.textName)") 'MiniMax-H3 GGUF 文本编码器'
    Invoke-Download 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors?download=true' (Join-Path $models 'vae\minimax_h3_video_vae_fp16.safetensors') 'MiniMax-H3 视频 VAE'
    Invoke-Download 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors?download=true' (Join-Path $models 'vae\minimax_h3_audio_vae_fp32.safetensors') 'MiniMax-H3 音频 VAE'
    $workflow = Join-Path $root 'workflows\kunpeng-h3-api.json'
    Write-InstallState 'running' '生成工作流' '正在生成与本机量化档匹配的 H3 API 工作流…' $root $preset.label
    Write-ManagedWorkflow $workflow $preset
    [ordered]@{ schemaVersion = 2; comfyUiRoot = $comfyRoot; workflowPath = $workflow; pythonPath = $python; endpoint = 'http://127.0.0.1:8188'; launchArgs = $preset.launchArgs; selectedPreset = $preset.label; installRoot = $root } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding UTF8
    Write-InstallState 'ready' '安装完成' "MiniMax-H3 已安装为 $($preset.label)。点击“启动本地服务”即可运行。" $root $preset.label
  } catch {
    Write-InstallState 'failed' '安装失败' $_.Exception.Message $root $preset.label
  }
}

function Start-H3Install([string]$Root) {
  $root = Assert-SafeInstallRoot $Root
  $state = Read-InstallState
  if ($state -and $state.state -eq 'running') { return }
  Assert-Hardware
  $preset = Get-H3Preset
  Assert-InstallDisk $root $preset.requiredDiskGiB
  Write-InstallState 'queued' '等待开始' "正在准备 $($preset.label) 一键安装…" $root $preset.label
  $arguments = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Action','InstallWorker','-InstallRoot',$root)
  Start-Process -FilePath 'pwsh.exe' -ArgumentList $arguments -WindowStyle Hidden | Out-Null
}

function Start-ComfyUi($config) {
  if (Test-ComfyHealth $config) { return }
  $tracked = Read-StateProcess $comfyStatePath
  if ($tracked) { throw '已启动的 ComfyUI 尚未通过本机健康检查。' }
  $uri = [uri]$config.endpoint
  $listener = Get-NetTCPConnection -State Listen -LocalPort $uri.Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { throw "ComfyUI 端口 $($uri.Port) 已被未受本阅读器管理的 PID $($listener.OwningProcess) 占用，且健康检查失败。" }
  $python = Get-ConfiguredPython $config
  $stdout = Join-Path $logRoot 'comfyui.log'; $stderr = Join-Path $logRoot 'comfyui-error.log'
  $launchArgs = @()
  if ($config.launchArgs) {
    $launchArgs = @($config.launchArgs | Where-Object { $_ -in @('--lowvram','--normalvram','--highvram') })
  }
  $process = Start-Process -FilePath $python -WorkingDirectory $config.comfyUiRoot -ArgumentList (@('main.py','--listen','127.0.0.1','--port',([string]$uri.Port)) + $launchArgs) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  [ordered]@{ processId = $process.Id; executable = $python; entry = 'main.py'; startedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $comfyStatePath -Encoding UTF8
  for ($attempt = 0; $attempt -lt 80; $attempt++) { Start-Sleep -Milliseconds 500; if (Test-ComfyHealth $config) { return }; if ($process.HasExited) { throw 'ComfyUI 进程启动后退出；请查看本机 ComfyUI 日志。' } }
  throw 'ComfyUI 未在 40 秒内通过本机健康检查。'
}

function Start-Bridge($config) {
  if (Test-BridgeHealth) { return }
  $tracked = Read-StateProcess $bridgeStatePath
  if ($tracked) { throw '阅读器 H3 桥接服务尚未通过本机健康检查。' }
  $listener = Get-NetTCPConnection -State Listen -LocalPort $bridgePort -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { throw "端口 $bridgePort 已被未受本阅读器管理的 PID $($listener.OwningProcess) 占用。" }
  $python = Get-ConfiguredPython $config
  $stdout = Join-Path $logRoot 'bridge.log'; $stderr = Join-Path $logRoot 'bridge-error.log'
  $process = Start-Process -FilePath $python -ArgumentList @($bridgeScript,'--backend','comfyui','--comfy-endpoint',$config.endpoint,'--workflow-template',$config.workflowPath,'--comfy-output',(Join-Path $config.comfyUiRoot 'output'),'--output-dir',$outputRoot,'--host','127.0.0.1','--port',([string]$bridgePort)) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  [ordered]@{ processId = $process.Id; executable = $python; entry = $bridgeScript; startedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $bridgeStatePath -Encoding UTF8
  for ($attempt = 0; $attempt -lt 30; $attempt++) { Start-Sleep -Milliseconds 500; if (Test-BridgeHealth) { return }; if ($process.HasExited) { throw '阅读器 H3 桥接服务启动后退出；请查看本机 bridge-error.log。' } }
  throw '阅读器 H3 桥接服务未在 15 秒内通过本机健康检查。'
}

function Start-LocalRuntime {
  Assert-Hardware
  $config = Read-Config
  $problems = @(Get-ConfigProblems $config)
  if ($problems.Count -gt 0) { throw "ComfyUI/GGUF 尚未配置：$($problems -join '；')" }
  if (@(Get-ModelArtifacts $config).Count -eq 0) { throw 'ComfyUI/GGUF 未发现 MiniMax-H3 本地量化模型文件。' }
  if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) { throw 'MiniMax-H3 ComfyUI 桥接脚本缺失。' }
  Start-ComfyUi $config
  Start-Bridge $config
}

function Stop-LocalRuntime {
  $bridge = Read-StateProcess $bridgeStatePath
  if ($bridge) { Stop-Process -Id $bridge.Id -Force }
  Remove-Item -LiteralPath $bridgeStatePath -Force -ErrorAction SilentlyContinue
  $comfy = Read-StateProcess $comfyStatePath
  if ($comfy) { Stop-Process -Id $comfy.Id -Force }
  Remove-Item -LiteralPath $comfyStatePath -Force -ErrorAction SilentlyContinue
}

switch ($Action) {
  'ConfigureComfyUi' { Configure-ComfyUi }
  'Start' { Start-LocalRuntime }
  'Stop' { Stop-LocalRuntime }
  'InstallAsync' { Start-H3Install $InstallRoot }
  'InstallWorker' { Install-H3Worker $InstallRoot }
  'Prepare' { }
}

Get-Status | ConvertTo-Json -Depth 5 -Compress
