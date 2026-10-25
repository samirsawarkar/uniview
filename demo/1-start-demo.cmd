@echo off
rem Starts UniView for the board demo. Uses the packaged app if built, else the installed one.
set "EXE=%~dp0..\release-candidate\win-unpacked\UniView.exe"
if not exist "%EXE%" set "EXE=%LOCALAPPDATA%\Programs\UniView\UniView.exe"
if not exist "%EXE%" (
  echo UniView.exe not found. Build it first: npm run dist:win
  pause
  exit /b 1
)
start "" "%EXE%"
exit /b 0
