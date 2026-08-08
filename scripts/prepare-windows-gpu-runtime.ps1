param(
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$destinationPath = [IO.Path]::GetFullPath((Join-Path $repo $Destination))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $repo "target"))
if (-not $destinationPath.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "GPU runtime destination must stay under target: $destinationPath"
}

$cache = Join-Path $targetRoot "windows-gpu-runtime-cache"
New-Item -ItemType Directory -Force -Path $cache, $destinationPath | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

$packages = @(
  @{
    Name = "onnxruntime_gpu-1.24.2-cp313-cp313-win_amd64.whl"
    Bytes = 207105650
    Sha256 = "48272AE9101E0762C5DB54703BCEDB9765C685F78890535843C74D7044DD8820"
    Url = "https://files.pythonhosted.org/packages/12/5d/229b3e9699af20d55865ef792d8389aa585c1f878418a482ccc2f8ca5863/onnxruntime_gpu-1.24.2-cp313-cp313-win_amd64.whl"
  },
  @{
    Name = "nvidia_cuda_runtime_cu12-12.8.90-py3-none-win_amd64.whl"
    Bytes = 944318
    Sha256 = "C0C6027F01505BFED6C3B21EC546F69C687689AAD5F1A377554BC6CA4AA993A8"
    Url = "https://files.pythonhosted.org/packages/30/a5/a515b7600ad361ea14bfa13fb4d6687abf500adc270f19e89849c0590492/nvidia_cuda_runtime_cu12-12.8.90-py3-none-win_amd64.whl"
  },
  @{
    Name = "nvidia_cudnn_cu12-9.10.2.21-py3-none-win_amd64.whl"
    Bytes = 692992268
    Sha256 = "C6288DE7D63E6CF62988F0923F96DC339CEA362DECB1BF5B3141883392A7D65E"
    Url = "https://files.pythonhosted.org/packages/3d/90/0bd6e586701b3a890fd38aa71c387dab4883d619d6e5ad912ccbd05bfd67/nvidia_cudnn_cu12-9.10.2.21-py3-none-win_amd64.whl"
  }
)

function Test-Package([string]$Path, [hashtable]$Spec) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -ne $Spec.Bytes) { return $false }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Spec.Sha256
}

function Get-Package([hashtable]$Spec) {
  $path = Join-Path $cache $Spec.Name
  if (Test-Package $path $Spec) { return $path }
  $download = "$path.download"
  Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
  Write-Host "Downloading verified GPU build dependency: $($Spec.Name)"
  Invoke-WebRequest -Uri $Spec.Url -OutFile $download -UseBasicParsing
  if (-not (Test-Package $download $Spec)) {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    throw "GPU build dependency integrity check failed: $($Spec.Name)"
  }
  Move-Item -LiteralPath $download -Destination $path -Force
  return $path
}

function Copy-WheelEntry([string]$Wheel, [string]$EntrySuffix, [string]$OutputName) {
  $archive = [IO.Compression.ZipFile]::OpenRead($Wheel)
  try {
    $entry = $archive.Entries | Where-Object {
      $_.FullName.EndsWith($EntrySuffix, [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if ($null -eq $entry) { throw "Missing $EntrySuffix in $(Split-Path -Leaf $Wheel)" }
    $output = Join-Path $destinationPath $OutputName
    $inputStream = $entry.Open()
    $outputStream = [IO.File]::Create($output)
    try { $inputStream.CopyTo($outputStream) }
    finally { $outputStream.Dispose(); $inputStream.Dispose() }
  } finally {
    $archive.Dispose()
  }
}

$ortWheel = Get-Package $packages[0]
$cudaWheel = Get-Package $packages[1]
$cudnnWheel = Get-Package $packages[2]

Copy-WheelEntry $ortWheel "/onnxruntime.dll" "onnxruntime.dll"
Copy-WheelEntry $ortWheel "/onnxruntime_providers_cuda.dll" "onnxruntime_providers_cuda.dll"
Copy-WheelEntry $ortWheel "/onnxruntime_providers_shared.dll" "onnxruntime_providers_shared.dll"
Copy-WheelEntry $ortWheel "/LICENSE" "ONNX-Runtime-LICENSE.txt"
Copy-WheelEntry $cudaWheel "/cudart64_12.dll" "cudart64_12.dll"
Copy-WheelEntry $cudaWheel "/License.txt" "NVIDIA-CUDA-LICENSE.txt"
Copy-WheelEntry $cudnnWheel "/cudnn64_9.dll" "cudnn64_9.dll"
Copy-WheelEntry $cudnnWheel "/License.txt" "NVIDIA-cuDNN-LICENSE.txt"

$expected = @{
  "onnxruntime.dll" = "326BCC42FCEA6EB12814518A9364F02959E76606F8EF2B1361686C7C3CF980FB"
  "onnxruntime_providers_cuda.dll" = "77109D6266E8F82BCFD77092226CC8618840C3CE592ECDEFD72F4644448FC762"
  "onnxruntime_providers_shared.dll" = "C0F79D3549AE77B1493AA2E2703DA2CF1EE97DE2F7CCC3CA724B1C282A3786A5"
  "cudart64_12.dll" = "C2C9A9C22A9BCBA90E261825968836787B331038047A26770CFFB7A583C28344"
  "cudnn64_9.dll" = "9EDBCDFF73B0AF070EB160B2CE66E59FECA04AA017351D8EEDCC5E8E149967D2"
}
foreach ($name in $expected.Keys) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $destinationPath $name) -Algorithm SHA256).Hash
  if ($actual -ne $expected[$name]) { throw "Extracted GPU runtime hash mismatch: $name" }
}

Get-Item -LiteralPath ($expected.Keys | ForEach-Object { Join-Path $destinationPath $_ }) |
  Select-Object FullName, Length, @{N = "SHA256"; E = { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } }
