@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is required.
  pause
  exit /b 1
)
start "" http://127.0.0.1:43110
node companion\src\native-harness\launcher.js
endlocal
