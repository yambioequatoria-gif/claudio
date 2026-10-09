@echo off
rem Starts Lite PDF now, in a visible window, for troubleshooting. Close the window to stop it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8080
pause
