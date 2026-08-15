# playnite-game-start.ps1
# Paste the body of this file into Playnite:
#   Main menu -> Settings... -> Scripts -> set the language selector to "PowerShell",
#   then put this in the "Execute script after starting a game" box.
# It tells the bot which game just launched so the bot can post a Discord popup.
#
# Adjust $port / $token below to match config/config.js (eventServerPort / eventServerToken).

$port  = 8799
$token = ""   # must match config.eventServerToken; leave "" if you left that blank

try {
    $source = if ($Game.Source) { $Game.Source.Name } else { "Local" }
    $platform = ($Game.Platforms | ForEach-Object { $_.Name }) -join ", "

    # Resolve the cover image to an absolute path the bot can read + attach (optional).
    $cover = ""
    if ($Game.CoverImage) {
        try { $cover = $PlayniteApi.Database.GetFullFilePath($Game.CoverImage) } catch { $cover = "" }
    }

    $body = @{
        name     = $Game.Name
        source   = $source
        platform = $platform
        cover    = $cover
    } | ConvertTo-Json -Compress

    $uri = "http://127.0.0.1:$port/playnite/start"
    if ($token -ne "") { $uri += "?token=$token" }

    Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType "application/json" -TimeoutSec 5 | Out-Null
} catch {
    # Bot offline / not listening — never block or delay the game launch.
}
