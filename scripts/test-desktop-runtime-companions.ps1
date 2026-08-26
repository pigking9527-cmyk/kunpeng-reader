param(
  [string]$BuildDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) "target\fast"),
  [string]$DeliveryDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

$required = @(
  "onnxruntime_providers_cuda.dll",
  "onnxruntime_providers_shared.dll"
)

foreach ($name in $required) {
  $source = Join-Path $BuildDirectory $name
  $destination = Join-Path $DeliveryDirectory $name
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Build output is missing required ONNX CUDA companion: $source"
  }
  if (-not (Test-Path -LiteralPath $destination)) {
    throw "Desktop shortcut target is missing required ONNX CUDA companion: $destination"
  }
  if ((Get-Sha256 $source) -ne (Get-Sha256 $destination)) {
    throw "Desktop ONNX CUDA companion does not match this build: $name"
  }
}

$copied = @(Get-ChildItem -LiteralPath $DeliveryDirectory -Filter "onnxruntime*.dll" -File)
if ($copied.Count -lt $required.Count) {
  throw "Desktop shortcut target has an incomplete ONNX Runtime companion set"
}

[pscustomobject]@{
  buildDirectory = [IO.Path]::GetFullPath($BuildDirectory)
  deliveryDirectory = [IO.Path]::GetFullPath($DeliveryDirectory)
  requiredProviderCompanions = $required.Count
  deliveredOnnxRuntimeCompanions = $copied.Count
  status = "ok"
} | ConvertTo-Json -Compress
