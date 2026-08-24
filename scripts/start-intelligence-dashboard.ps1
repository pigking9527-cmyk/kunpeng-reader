[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 38421,
  [switch]$Build
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $projectRoot 'target\debug\kunpeng-intelligence-host.exe'

if ($Build -or -not (Test-Path -LiteralPath $binary -PathType Leaf)) {
  Push-Location $projectRoot
  try {
    cargo build --bin kunpeng-intelligence-host
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
  throw '未找到本机情报主机。请确认 cargo build 已成功完成。'
}

Write-Host "本机情报工作台: http://127.0.0.1:$Port"
Write-Host '只监听本机。关闭此窗口即可停止工作台；页面中的处理动作需要显式点击。'
& $binary --dashboard $Port
