param(
    [ValidateRange(1, 100)]
    [int]$Samples = 10,
    [ValidateRange(1000, 120000)]
    [int]$TimeoutMs = 30000
)

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop '鲲鹏阅读器.lnk'
if (-not (Test-Path -LiteralPath $shortcutPath)) {
    throw "未找到桌面快捷方式：$shortcutPath"
}

$shell = New-Object -ComObject WScript.Shell
$targetPath = [IO.Path]::GetFullPath($shell.CreateShortcut($shortcutPath).TargetPath)
if (-not (Test-Path -LiteralPath $targetPath)) {
    throw "快捷方式目标不存在：$targetPath"
}

if (-not ('KunpengStartupWindowProbe' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class KunpengStartupWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static bool HasVisibleTopLevelWindow(int targetProcessId) {
        bool found = false;
        EnumWindows(delegate(IntPtr hWnd, IntPtr unused) {
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId != targetProcessId || !IsWindowVisible(hWnd)) return true;
            RECT rect;
            if (GetWindowRect(hWnd, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top) {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
}

function Get-TargetReaderProcesses {
    @(Get-Process -Name '鲲鹏阅读器' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $targetPath
    })
}

function Stop-TargetReader {
    $running = Get-TargetReaderProcesses
    if ($running.Count -gt 0) {
        $running | Stop-Process -Force
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        while ((Get-TargetReaderProcesses).Count -gt 0) {
            if ($deadline.ElapsedMilliseconds -ge 5000) {
                throw '鲲鹏阅读器进程在 5 秒内未退出，无法继续进行冷启动测量。'
            }
            Start-Sleep -Milliseconds 50
        }
    }
}

Write-Host "冷启动测量：$Samples 次（进程启动 → 第一个可见窗口）" -ForegroundColor Cyan
Write-Host "目标：$targetPath" -ForegroundColor DarkGray
Write-Host '注意：每轮都会强制结束阅读器；请先保存当前阅读内容。' -ForegroundColor Yellow

$results = [System.Collections.Generic.List[object]]::new()
for ($sample = 1; $sample -le $Samples; $sample++) {
    Stop-TargetReader
    Start-Sleep -Milliseconds 350
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $targetPath -PassThru
    $visible = $false
    while ($timer.ElapsedMilliseconds -lt $TimeoutMs) {
        if ($process.HasExited) { break }
        if ([KunpengStartupWindowProbe]::HasVisibleTopLevelWindow($process.Id)) {
            $visible = $true
            break
        }
        Start-Sleep -Milliseconds 15
        $process.Refresh()
    }
    $timer.Stop()
    $milliseconds = [Math]::Round($timer.Elapsed.TotalMilliseconds, 1)
    $status = if ($visible) { 'visible' } elseif ($process.HasExited) { 'exited' } else { 'timeout' }
    $results.Add([PSCustomObject]@{
        Sample = $sample
        StartupMs = $milliseconds
        Status = $status
        ProcessId = $process.Id
        Timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
    })
    Write-Host ('{0,2}/{1}: {2,8:N1} ms  {3}' -f $sample, $Samples, $milliseconds, $status) -ForegroundColor $(if ($visible) { 'Green' } else { 'Red' })
    if (-not $visible) { Stop-TargetReader }
}

$success = @($results | Where-Object Status -eq 'visible')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$csvPath = Join-Path $desktop "鲲鹏阅读器冷启动-$stamp.csv"
$summaryPath = Join-Path $desktop "鲲鹏阅读器冷启动-$stamp.txt"
$results | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding utf8BOM

if ($success.Count -gt 0) {
    $times = @($success | ForEach-Object { [double]$_.StartupMs } | Sort-Object)
    $average = [Math]::Round((($times | Measure-Object -Average).Average), 1)
    $minimum = [Math]::Round($times[0], 1)
    $maximum = [Math]::Round($times[$times.Count - 1], 1)
    $p95 = [Math]::Round($times[[Math]::Ceiling($times.Count * 0.95) - 1], 1)
    $summary = @(
        "鲲鹏阅读器冷启动测量（进程启动到第一个可见窗口）",
        "目标：$targetPath",
        "样本：$($success.Count)/$Samples 成功",
        "平均：$average ms",
        "P95：$p95 ms",
        "最小：$minimum ms",
        "最大：$maximum ms",
        "CSV：$csvPath"
    )
} else {
    $summary = @(
        '鲲鹏阅读器冷启动测量未获得可见窗口样本。',
        "目标：$targetPath",
        "CSV：$csvPath"
    )
}
$summary | Set-Content -LiteralPath $summaryPath -Encoding utf8BOM
$summary | ForEach-Object { Write-Host $_ }
Write-Host "汇总已保存：$summaryPath" -ForegroundColor Cyan
