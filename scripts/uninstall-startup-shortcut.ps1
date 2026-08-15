# uninstall-startup-shortcut.ps1
# Removes the Startup-folder shortcut created by install-startup-shortcut.ps1.
#     powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup-shortcut.ps1

$ErrorActionPreference = 'Stop'

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'PlexDiscordBot.lnk'

if (Test-Path $lnk) {
    Remove-Item $lnk -Force
    Write-Host "Removed startup shortcut:" $lnk
} else {
    Write-Host "No startup shortcut found at:" $lnk
}
