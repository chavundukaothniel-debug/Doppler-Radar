@echo off
setlocal
title Doppler Radar Dashboard
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dashboard.ps1"
if errorlevel 1 (
  echo.
  echo Dashboard stopped with an error. See the message above.
  pause
)
endlocal
