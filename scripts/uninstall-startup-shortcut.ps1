# uninstall-startup-shortcut.ps1
# Removes everything install-startup-shortcut.ps1 created. Does not stop a running bot.
#     powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup-shortcut.ps1

$ErrorActionPreference = 'Stop'

$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Startup')) 'PlexDiscordBot.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Start Plex Bot.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Stop Plex Bot.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Plex Bot Status.lnk')
)

$removed = 0
foreach ($t in $targets) {
    if (Test-Path $t) {
        Remove-Item $t -Force
        Write-Host "Removed $t"
        $removed++
    }
}

if ($removed -eq 0) {
    Write-Host "Nothing to remove."
} else {
    Write-Host ""
    Write-Host "The bot will no longer start at login. A bot running right now keeps running;"
    Write-Host "use scripts\stop-bot.ps1 to stop it."
}
