@echo off
title Plex Discord Bot
rem start-bot.cmd
rem Runs the bot in a visible console. Closing the window stops the bot, which is the point:
rem the hidden launcher (start-bot.vbs) leaves nothing on screen to close.
rem
rem The repo root is resolved with %%~fI so ".." is collapsed out of the path. The running node
rem process advertises whatever path it was given, and scripts\stop-bot.ps1 finds the bot by
rem looking for the real one, which "scripts\..\index.js" would not match.

for %%I in ("%~dp0..") do set "BOTROOT=%%~fI"

if not exist "%BOTROOT%\index.js" (
    echo Could not find index.js under "%BOTROOT%".
    echo This script has to stay in the scripts folder of the install.
    pause
    exit /b 1
)

cd /d "%BOTROOT%"

rem Only the hidden launcher writes this file. Left behind, it would make the status window
rem report errors from some previous windowless run as if they came from this one.
if exist "%BOTROOT%\data\logs\startup-stderr.log" del /q "%BOTROOT%\data\logs\startup-stderr.log"

rem The bot does not print its log here, and that is deliberate. A Windows console that enters
rem selection mode — one click or drag inside the window is enough — blocks the process that owns
rem it on its next write until the selection is cleared. With the log mirrored here, that froze
rem the whole bot: it stopped relaying, stopped answering commands, and the log file stopped dead
rem at the moment of the click with nothing in it to explain why. A window sitting in that state
rem for a day is how this was found.
rem
rem The log goes to data\logs\bot-<date>.log regardless; scripts\status-bot.ps1 reads it.
set "PLEXBOT_LOG_TO_CONSOLE=0"

echo ===============================================
echo  Plex Discord Bot
echo  %BOTROOT%
echo.
echo  Close this window to stop the bot.
echo.
echo  The log is not shown here. Read it with:
echo    scripts\status-bot.ps1
echo ===============================================
echo.

node "%BOTROOT%\index.js"

echo.
echo ===============================================
echo  The bot has stopped. Exit code: %ERRORLEVEL%
echo  This window stays open so you can read why.
echo ===============================================
pause
