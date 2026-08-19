@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo [ERROR] runtime\node.exe is missing. Please extract the complete ZIP again.
  pause
  exit /b 1
)
start "API Capture Harness" /B "%~dp0runtime\node.exe" "%~dp0companion\src\native-harness\launcher.js"
endlocal
