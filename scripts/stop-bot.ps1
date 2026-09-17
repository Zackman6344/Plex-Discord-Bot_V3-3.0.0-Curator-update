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

# Close the launcher window too, matched on the launcher script rather than on index.js.
#
# start-bot.cmd runs node itself, so the shell's own command line names the .cmd and never
# index.js - which the old filter here looked for, and so never matched. Windows piled up parked
# at the script's closing `pause`, one per stop, and a parked one is not harmless:
#
#   cmd.exe reads a batch file as it goes, by byte offset. Rewriting start-bot.cmd while a window
#   sits parked in it - a deploy, a git merge, an edit - moves the offsets under it, and cmd
#   resumes wherever that lands. Observed: a window parked at `pause` re-ran the node line after
#   the file grew, giving a SECOND bot alongside the one just started. Two instances double every
#   relayed line and answer every command twice.
$launcher = Join-Path $PSScriptRoot 'start-bot.cmd'
$shells = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($entry) -or $_.CommandLine.Contains($launcher)) })
foreach ($s in $shells) {
    Write-Host ("Closing launcher window PID {0}" -f $s.ProcessId)
    try { Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop } catch { }
}

# Re-checked and retried rather than reported once. A process that appears after the first scan
# is a second instance, and leaving one running is worse than taking a moment longer here.
$left = @()
for ($attempt = 1; $attempt -le 3; $attempt++) {
    Start-Sleep -Milliseconds 500
    $left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) })
    if ($left.Count -eq 0) { break }
    Write-Host ("Still {0} running after attempt {1} - stopping again" -f $left.Count, $attempt) -ForegroundColor Yellow
    foreach ($p in $left) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
    }
}

if ($left.Count -eq 0) {
    Write-Host "Bot stopped." -ForegroundColor Green
} else {
    Write-Host ("Still running: {0} process(es). End node.exe in Task Manager." -f $left.Count) -ForegroundColor Red
}

Start-Sleep -Seconds 2
