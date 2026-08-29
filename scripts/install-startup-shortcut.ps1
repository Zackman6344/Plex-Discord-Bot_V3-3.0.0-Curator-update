# install-startup-shortcut.ps1
# Sets up the bot to launch at login, and puts Start / Stop / Status shortcuts on the desktop.
# Run this ONCE, from your main install directory:
#     powershell -ExecutionPolicy Bypass -File scripts\install-startup-shortcut.ps1
# It resolves all paths relative to itself, so no editing is needed. Run it again after moving
# the install folder.

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptDir
$vbs = Join-Path $scriptDir 'start-bot.vbs'
$stopPs1 = Join-Path $scriptDir 'stop-bot.ps1'
$statusPs1 = Join-Path $scriptDir 'status-bot.ps1'

foreach ($required in @($vbs, $stopPs1, $statusPs1, (Join-Path $repoRoot 'index.js'))) {
    if (-not (Test-Path $required)) { throw "Missing $required" }
}

# The login shell has its own PATH. A node that only exists in this terminal's PATH would make
# the bot start now and fail silently at every boot, which is the confusing failure to avoid.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH. Install Node.js, or the startup shortcut cannot work." }
Write-Host "Using node: $node"

$wshell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')
$powershellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function New-Lnk {
    param($Path, $Target, $Arguments, $Description, $IconLocation)
    $lnk = $wshell.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    $lnk.Arguments = $Arguments
    $lnk.WorkingDirectory = $repoRoot
    $lnk.Description = $Description
    if ($IconLocation) { $lnk.IconLocation = $IconLocation }
    $lnk.Save()
    Write-Host "  created $Path"
}

Write-Host ""
Write-Host "Installing:"

# Launch at login, hidden. wscript.exe runs the .vbs without a console window.
New-Lnk -Path (Join-Path $startup 'PlexDiscordBot.lnk') `
        -Target (Join-Path $env:WINDIR 'System32\wscript.exe') `
        -Arguments ('"' + $vbs + '"') `
        -Description 'Launch the Plex Discord bot at login'

New-Lnk -Path (Join-Path $desktop 'Start Plex Bot.lnk') `
        -Target (Join-Path $env:WINDIR 'System32\wscript.exe') `
        -Arguments ('"' + $vbs + '"') `
        -Description 'Start the Plex Discord bot' `
        -IconLocation "$node,0"

New-Lnk -Path (Join-Path $desktop 'Stop Plex Bot.lnk') `
        -Target $powershellExe `
        -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + $stopPs1 + '"') `
        -Description 'Stop the Plex Discord bot' `
        -IconLocation "$env:WINDIR\System32\shell32.dll,27"

New-Lnk -Path (Join-Path $desktop 'Plex Bot Status.lnk') `
        -Target $powershellExe `
        -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + $statusPs1 + '"') `
        -Description 'Is the Plex Discord bot running, and what does its log say' `
        -IconLocation "$env:WINDIR\System32\shell32.dll,23"

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  The bot now starts automatically when you log in."
Write-Host "  Desktop: 'Start Plex Bot', 'Stop Plex Bot', 'Plex Bot Status'."
Write-Host "  To start it right now without rebooting, double-click 'Start Plex Bot'."
Write-Host "  To undo all of this: powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup-shortcut.ps1"
