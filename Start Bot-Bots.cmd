@echo off
setlocal
cd /d "%~dp0"
set "BOT_BOTS_DATA_DIR=%CD%\data"
set "ELECTRON_RUN_AS_NODE="
if exist "release\0.2.21\win-unpacked\Bot-Bots.exe" goto botpanel
if exist "release\0.2.20\win-unpacked\Bot-Bots.exe" goto publicstarter
if exist "release\0.2.19\win-unpacked\Bot-Bots.exe" goto teamconversations
if exist "release\0.2.18\win-unpacked\Bot-Bots.exe" goto frontiermodels
if exist "release\0.2.17\win-unpacked\Bot-Bots.exe" goto publishingrecovery
if exist "release\0.2.16\win-unpacked\Bot-Bots.exe" goto sharedskills
if exist "release\0.2.15\win-unpacked\Bot-Bots.exe" goto servicealiases
if exist "release\0.2.14\win-unpacked\Bot-Bots.exe" goto services
if exist "release\0.2.13\win-unpacked\Bot-Bots.exe" goto conversational
if exist "release\0.2.12\win-unpacked\Bot-Bots.exe" goto livebuilds
if exist "release\0.2.11\win-unpacked\Bot-Bots.exe" goto credentialwindow
if exist "release\0.2.10\win-unpacked\Bot-Bots.exe" goto apphelp
if exist "release\0.2.9\win-unpacked\Bot-Bots.exe" goto refreshedteam
if exist "release\0.2.8\win-unpacked\Bot-Bots.exe" goto securehost
if exist "release\0.2.7\win-unpacked\Bot-Bots.exe" goto pinnedmain
if exist "release\0.2.6\win-unpacked\Bot-Bots.exe" goto mainbot
if exist "release\0.2.5\win-unpacked\Bot-Bots.exe" goto friendly
if exist "release\0.2.4\win-unpacked\Bot-Bots.exe" goto deliveries
if exist "release\0.2.3\win-unpacked\Bot-Bots.exe" goto googlesignin
if exist "release\0.2.2\win-unpacked\Bot-Bots.exe" goto simpleicon
if exist "release\0.2.1\win-unpacked\Bot-Bots.exe" goto discovery
if exist "release\0.2.0\win-unpacked\Bot-Bots.exe" goto workshop
if exist "release\0.1.9\win-unpacked\Bot-Bots.exe" goto drafts
if exist "release\0.1.8\win-unpacked\Bot-Bots.exe" goto steering
if exist "release\0.1.7\win-unpacked\Bot-Bots.exe" goto workbench
if exist "release\0.1.6\win-unpacked\Bot-Bots.exe" goto computer
if exist "release\0.1.5\win-unpacked\Bot-Bots.exe" goto experience
if exist "release\0.1.4\win-unpacked\Bot-Bots.exe" goto collaboration
if exist "release\0.1.3\win-unpacked\Bot-Bots.exe" goto roster
if exist "release\0.1.2\win-unpacked\Bot-Bots.exe" goto darkmode
if exist "release\0.1.1\win-unpacked\Bot-Bots.exe" goto updated
if exist "release\win-unpacked\Bot-Bots.exe" goto packaged
if not exist "dist\desktop\main.js" goto missing
if not exist "node_modules\electron\dist\electron.exe" goto missing
start "Bot-Bots" "node_modules\electron\dist\electron.exe" .
exit /b 0
:packaged
start "Bot-Bots" "release\win-unpacked\Bot-Bots.exe"
exit /b 0
:botpanel
start "Bot-Bots" "release\0.2.21\win-unpacked\Bot-Bots.exe"
exit /b 0
:updated
start "Bot-Bots" "release\0.1.1\win-unpacked\Bot-Bots.exe"
exit /b 0
:darkmode
start "Bot-Bots" "release\0.1.2\win-unpacked\Bot-Bots.exe"
exit /b 0
:roster
start "Bot-Bots" "release\0.1.3\win-unpacked\Bot-Bots.exe"
exit /b 0
:collaboration
start "Bot-Bots" "release\0.1.4\win-unpacked\Bot-Bots.exe"
exit /b 0
:experience
start "Bot-Bots" "release\0.1.5\win-unpacked\Bot-Bots.exe"
exit /b 0
:missing
echo Bot-Bots needs its dependencies and build output.
echo See README.md for setup, then run this launcher again.
pause
exit /b 1
:computer
start "Bot-Bots" "release\0.1.6\win-unpacked\Bot-Bots.exe"
exit /b 0
:workbench
start "Bot-Bots" "release\0.1.7\win-unpacked\Bot-Bots.exe"
exit /b 0
:steering
start "Bot-Bots" "release\0.1.8\win-unpacked\Bot-Bots.exe"
exit /b 0
:drafts
start "Bot-Bots" "release\0.1.9\win-unpacked\Bot-Bots.exe"
exit /b 0
:workshop
start "Bot-Bots" "release\0.2.0\win-unpacked\Bot-Bots.exe"
exit /b 0
:discovery
start "Bot-Bots" "release\0.2.1\win-unpacked\Bot-Bots.exe"
exit /b 0
:simpleicon
start "Bot-Bots" "release\0.2.2\win-unpacked\Bot-Bots.exe"
exit /b 0
:googlesignin
start "Bot-Bots" "release\0.2.3\win-unpacked\Bot-Bots.exe"
exit /b 0
:deliveries
start "Bot-Bots" "release\0.2.4\win-unpacked\Bot-Bots.exe"
exit /b 0
:friendly
start "Bot-Bots" "release\0.2.5\win-unpacked\Bot-Bots.exe"
exit /b 0
:mainbot
start "Bot-Bots" "release\0.2.6\win-unpacked\Bot-Bots.exe"
exit /b 0
:pinnedmain
start "Bot-Bots" "release\0.2.7\win-unpacked\Bot-Bots.exe"
exit /b 0
:securehost
start "Bot-Bots" "release\0.2.8\win-unpacked\Bot-Bots.exe"
exit /b 0
:refreshedteam
start "Bot-Bots" "release\0.2.9\win-unpacked\Bot-Bots.exe"
exit /b 0
:apphelp
start "Bot-Bots" "release\0.2.10\win-unpacked\Bot-Bots.exe"
exit /b 0
:credentialwindow
start "Bot-Bots" "release\0.2.11\win-unpacked\Bot-Bots.exe"
exit /b 0
:livebuilds
start "Bot-Bots" "release\0.2.12\win-unpacked\Bot-Bots.exe"
exit /b 0
:conversational
start "Bot-Bots" "release\0.2.13\win-unpacked\Bot-Bots.exe"
exit /b 0
:services
start "Bot-Bots" "release\0.2.14\win-unpacked\Bot-Bots.exe"
exit /b 0
:servicealiases
start "Bot-Bots" "release\0.2.15\win-unpacked\Bot-Bots.exe"
exit /b 0
:sharedskills
start "Bot-Bots" "release\0.2.16\win-unpacked\Bot-Bots.exe"
exit /b 0
:publishingrecovery
start "Bot-Bots" "release\0.2.17\win-unpacked\Bot-Bots.exe"
exit /b 0
:frontiermodels
start "Bot-Bots" "release\0.2.18\win-unpacked\Bot-Bots.exe"
exit /b 0
:teamconversations
start "Bot-Bots" "release\0.2.19\win-unpacked\Bot-Bots.exe"
exit /b 0
:publicstarter
start "Bot-Bots" "release\0.2.20\win-unpacked\Bot-Bots.exe"
exit /b 0
