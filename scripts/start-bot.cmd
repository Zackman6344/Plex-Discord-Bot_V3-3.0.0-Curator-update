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

echo ===============================================
echo  Plex Discord Bot
echo  %BOTROOT%
echo.
echo  Close this window to stop the bot.
echo ===============================================
echo.

node "%BOTROOT%\index.js"

echo.
echo ===============================================
echo  The bot has stopped. Exit code: %ERRORLEVEL%
echo  This window stays open so you can read why.
echo ===============================================
pause
