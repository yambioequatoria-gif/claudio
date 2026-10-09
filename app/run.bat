@echo off
rem Starts Lite PDF on http://localhost:8080 (this computer only). Leave this window open while using the app.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8080
pause
