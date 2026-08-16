' start-bot.vbs
' Launches the Plex Discord bot with NO console window — meant for the Startup folder.
' The repo root is resolved as the parent of this script's folder, so it works from any
' install path without editing. Output is appended to bot.log in the repo root.
' Requires Node.js to be on PATH (it is by default after a standard Node install).
Option Explicit

Dim fso, shell, scriptDir, repoRoot, logPath, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)

shell.CurrentDirectory = repoRoot
logPath = fso.BuildPath(repoRoot, "bot.log")

' 0 = hidden window, False = don't wait for the process to exit.
cmd = "cmd /c node index.js >> """ & logPath & """ 2>&1"
shell.Run cmd, 0, False
