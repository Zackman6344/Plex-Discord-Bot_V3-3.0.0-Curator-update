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

# helpers/logger.js names its files from the UTC date, so building this from the local date
# pointed at yesterday's file every evening west of UTC: the status window went blank, or showed
# stale lines, exactly when something had just happened. Take whichever file was written last
# instead, which is right regardless of timezone or a date that rolled mid-session.
#
# Taking the newest file lost the signal the date-named lookup used to carry: with retention now
# unlimited, old bot-*.log files are never removed, so there is always a candidate and a days-old
# log printed under a header that reads like live output. Say how old it is instead.
$logDir = Join-Path $repoRoot 'data\logs'
$newestLog = Get-ChildItem $logDir -Filter 'bot-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime | Select-Object -Last 1
if ($newestLog) {
    $age = (Get-Date) - $newestLog.LastWriteTime
    Write-Host ""
    if ($age.TotalHours -lt 24) {
        Write-Host ("Last 15 lines of {0} (written {1:N0} min ago)" -f $newestLog.Name, $age.TotalMinutes)
    } else {
        Write-Host ("Last 15 lines of {0} — STALE, last written {1:N1} days ago, so this is not live output" -f $newestLog.Name, $age.TotalDays) -ForegroundColor Yellow
    }
    Get-Content $newestLog.FullName -Tail 15 -Encoding UTF8
}

# Written only by the hidden launcher (start-bot.vbs); the console launcher shows errors in its
# own window and deletes this file on start, so anything here belongs to a windowless run.
$early = Join-Path $repoRoot 'data\logs\startup-stderr.log'
if ((Test-Path $early) -and (Get-Item $early).Length -gt 0) {
    Write-Host ""
    Write-Host ("Errors from a windowless launch, {0} (startup-stderr.log):" -f (Get-Item $early).LastWriteTime) -ForegroundColor Yellow
    Get-Content $early -Tail 20 -Encoding UTF8
}

Write-Host ""
Read-Host "Press Enter to close"
