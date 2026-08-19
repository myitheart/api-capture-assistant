@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0companion\src\diagnostics\stop-companion.js"
if errorlevel 1 pause
endlocal
