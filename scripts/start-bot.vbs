' start-bot.vbs
' Launches the Plex Discord bot with NO console window, for the Startup folder and the
' "Start Plex Bot" desktop shortcut. The repo root is resolved as the parent of this script's
' folder, so it works from any install path without editing.
'
' index.js is passed as an ABSOLUTE path on purpose. Windows records the command line of the
' node process, and stop-bot.ps1 finds the bot by looking for that path in it. Launched as a
' bare "node index.js" the command line carries no clue which node process this is, and
' stopping it would mean guessing.
'
' The bot's own log lives in data/logs/, so only stderr is captured here: a crash early enough
' that the logger never loaded, plus error-level lines. Capturing stdout as well duplicated the
' whole log into this file and grew it for as long as the bot stayed up. Truncated each launch,
' so it always describes the most recent start rather than every start since install.
Option Explicit

Dim fso, shell, scriptDir, repoRoot, logDir, logPath, entry, cmd, errPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)
entry = fso.BuildPath(repoRoot, "index.js")

logDir = fso.BuildPath(repoRoot, "data\logs")
If Not fso.FolderExists(fso.BuildPath(repoRoot, "data")) Then fso.CreateFolder fso.BuildPath(repoRoot, "data")
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
errPath = fso.BuildPath(logDir, "startup-stderr.log")

shell.CurrentDirectory = repoRoot

' 0 = hidden window, False = don't wait for the process to exit.
cmd = "cmd /c node """ & entry & """ > nul 2> """ & errPath & """"
shell.Run cmd, 0, False
