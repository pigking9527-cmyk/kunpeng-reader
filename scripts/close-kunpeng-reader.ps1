$ErrorActionPreference = 'Stop'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) '鲲鹏阅读器.lnk'
if (-not (Test-Path -LiteralPath $shortcutPath)) { exit 0 }

$shell = New-Object -ComObject WScript.Shell
$targetPath = [IO.Path]::GetFullPath($shell.CreateShortcut($shortcutPath).TargetPath)
foreach ($process in Get-Process -Name '鲲鹏阅读器' -ErrorAction SilentlyContinue) {
  if ($process.Path -and [IO.Path]::GetFullPath($process.Path) -eq $targetPath) {
    Stop-Process -Id $process.Id -Force
  }
}
