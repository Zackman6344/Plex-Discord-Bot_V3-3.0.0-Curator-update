# stop-bot-pipe.ps1
# Asks a running bot to shut down by itself over its single-instance pipe (helpers/singleInstance.js),
# because Stop-Process -Force runs none of its shutdown code. stop-bot.ps1 and test/stopBotPipe.test.js
# dot-source this file; it only defines functions.
#
# The pipe's name is a hash of the bot token, so this lists the pipes instead of computing one, and
# acts only on the pipe whose holder names the same PID and the same index.js.

function Read-PipeLine($reader, [int]$ms) {
    $task = $reader.ReadLineAsync()
    if (-not $task.Wait($ms)) { return $null }
    return $task.Result
}

function Request-CleanStop {
    param(
        [int]$ProcessId,
        [string]$PipeFilter = 'plex-discord-bot-*',
        [string]$Entry = (Join-Path $repoRoot 'index.js')
    )
    try {
        $pipes = [System.IO.Directory]::GetFiles('\\.\pipe\', $PipeFilter)
    } catch {
        return [pscustomobject]@{ Result = 'none'; Why = $null }
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    foreach ($pipe in $pipes) {
        $name = $pipe.Substring($pipe.LastIndexOf('\') + 1)
        if ($name -notmatch '^plex-discord-bot-[0-9a-f]{16}$') { continue }
        $client = $null
        try {
            # Asynchronous, or a read still waiting on the pipe would block the write of the request.
            $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name,
                [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
            $client.Connect(2000)
            $reader = New-Object System.IO.StreamReader($client, $utf8)
            $line = Read-PipeLine $reader 2000
            if (-not $line) { continue }
            $info = $line | ConvertFrom-Json
            if ([int]$info.pid -ne $ProcessId) { continue }
            if (-not [string]::Equals([string]$info.entry, $Entry, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            if (-not ($info.accepts -contains 'stop')) { return [pscustomobject]@{ Result = 'old'; Why = $null } }
            $bytes = $utf8.GetBytes("stop`n")
            $client.Write($bytes, 0, $bytes.Length)
            $client.Flush()
            $reply = Read-PipeLine $reader 2000
            if (-not $reply) { return [pscustomobject]@{ Result = 'none'; Why = $null } }
            $answer = $reply | ConvertFrom-Json
            if ($answer.stopping -eq $true) { return [pscustomobject]@{ Result = 'asked'; Why = $null } }
            return [pscustomobject]@{ Result = 'refused'; Why = [string]$answer.why }
        } catch {
            continue
        } finally {
            # The bot waits for this hang-up before it starts shutting down.
            if ($client) { $client.Dispose() }
        }
    }
    return [pscustomobject]@{ Result = 'none'; Why = $null }
}

function Wait-Exit([int]$ProcessId, [int]$TimeoutMs) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}
