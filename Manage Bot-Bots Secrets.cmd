@echo off
setlocal
cd /d "%~dp0"
set "BOT_BOTS_NODE=node"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "BOT_BOTS_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "dist\manage-secrets.js" goto missing
"%BOT_BOTS_NODE%" dist\manage-secrets.js %*
if not "%~1"=="" exit /b %ERRORLEVEL%
echo.
echo Examples: Manage Bot-Bots Secrets.cmd init
echo           Manage Bot-Bots Secrets.cmd set netlify-token
echo           Manage Bot-Bots Secrets.cmd remove netlify-token
pause
exit /b 0
:missing
echo Build the app first. See docs\SECRETS.md.
pause
exit /b 1
