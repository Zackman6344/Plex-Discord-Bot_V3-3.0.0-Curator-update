# install-startup-shortcut.ps1
# Adds a shortcut to your Windows Startup folder so the bot launches automatically at login.
# Run this ONCE, from your main install directory:
#     powershell -ExecutionPolicy Bypass -File scripts\install-startup-shortcut.ps1
# It resolves all paths relative to itself, so no editing is needed.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $scriptDir 'start-bot.vbs'
if (-not (Test-Path $vbs)) { throw "start-bot.vbs not found next to this script ($vbs)" }

$repoRoot = Split-Path -Parent $scriptDir
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'PlexDiscordBot.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + $vbs + '"'
$shortcut.WorkingDirectory = $repoRoot
$shortcut.Description = 'Launch the Plex Discord bot at login'
$shortcut.Save()

Write-Host "Installed startup shortcut:" $lnk
Write-Host "The bot will now start automatically each time you log in."
Write-Host "To start it right now without rebooting, run:  wscript `"$vbs`""
