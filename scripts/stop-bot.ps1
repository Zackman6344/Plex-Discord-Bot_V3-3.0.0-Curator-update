# stop-bot.ps1
# Stops the Plex Discord bot started by start-bot.vbs (or by `node index.js` in this folder).
#     powershell -ExecutionPolicy Bypass -File scripts\stop-bot.ps1
# The "Stop Plex Bot" desktop shortcut runs exactly this.
#
# It matches on the full path to THIS install's index.js in the process command line, so it
# cannot take down an unrelated node process. Other Node apps on the machine (Adobe's helper,
# a dev server, another bot) are left alone.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repoRoot 'index.js'

Write-Host "Looking for the bot running from: $entry"

# -like would treat the path's [ ] as wildcards, so match with a plain substring test.
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) })

if ($procs.Count -eq 0) {
    Write-Host "The bot is not running." -ForegroundColor Yellow
    Start-Sleep -Seconds 2
    exit 0
}

foreach ($p in $procs) {
    Write-Host ("Stopping node.exe PID {0}" -f $p.ProcessId)
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    } catch {
        Write-Host ("  could not stop PID {0}: {1}" -f $p.ProcessId, $_.Exception.Message) -ForegroundColor Red
    }
}

# The launcher wraps node in `cmd /c` to capture early crash output. That shell exits on its
# own once node is gone, but a stray one left behind would hold the log file open.
$shells = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) })
foreach ($s in $shells) {
    try { Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop } catch { }
}

Start-Sleep -Milliseconds 400
$left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) })

if ($left.Count -eq 0) {
    Write-Host "Bot stopped." -ForegroundColor Green
} else {
    Write-Host ("Still running: {0} process(es). Try again, or end node.exe in Task Manager." -f $left.Count) -ForegroundColor Red
}

Start-Sleep -Seconds 2
