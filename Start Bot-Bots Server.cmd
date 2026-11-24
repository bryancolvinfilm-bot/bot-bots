@echo off
setlocal
cd /d "%~dp0"
set "BOT_BOTS_NODE=node"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "BOT_BOTS_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%BOT_BOTS_NODE%" dist\server\index.js
pause
