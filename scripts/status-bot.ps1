# status-bot.ps1
# Says whether this install's bot is running, and shows the tail of its log.
#     powershell -ExecutionPolicy Bypass -File scripts\status-bot.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repoRoot 'index.js'

$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) })

if ($procs.Count -eq 0) {
    Write-Host "The bot is NOT running." -ForegroundColor Yellow
} else {
    foreach ($p in $procs) {
        # Get-CimInstance hands back a real DateTime. Only the older Get-WmiObject needs the
        # DMTF string conversion, which throws here.
        $started = $p.CreationDate
        $uptime = if ($started) { ' (up {0:hh\:mm\:ss})' -f (New-TimeSpan -Start $started -End (Get-Date)) } else { '' }
        Write-Host ("Running. PID {0}, started {1}{2}" -f $p.ProcessId, $started, $uptime) -ForegroundColor Green
    }
}

$today = Join-Path $repoRoot ("data\logs\bot-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
if (Test-Path $today) {
    Write-Host ""
    Write-Host "Last 15 lines of $today"
    Get-Content $today -Tail 15 -Encoding UTF8
}

# stderr from this launch: a crash before the logger loaded, plus any error-level lines.
$early = Join-Path $repoRoot 'data\logs\startup-stderr.log'
if ((Test-Path $early) -and (Get-Item $early).Length -gt 0) {
    Write-Host ""
    Write-Host "Errors from this launch (startup-stderr.log):" -ForegroundColor Yellow
    Get-Content $early -Tail 20 -Encoding UTF8
}

Write-Host ""
Read-Host "Press Enter to close"
