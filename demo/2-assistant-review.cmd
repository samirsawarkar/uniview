@echo off
rem Plays the part of an AI assistant: asks UniView for a review and waits for the person's decision.
set "EXE=%~dp0..\release-candidate\win-unpacked\UniView.exe"
if not exist "%EXE%" set "EXE=%LOCALAPPDATA%\Programs\UniView\UniView.exe"
node "%~dp0make-demo.mjs"
echo.
echo Assistant: asking UniView for a review and waiting for your decision...
echo.
"%EXE%" open --wait --timeout 300 --receipt "%~dp0demo-review.receipt.json" "%~dp0files\sales.xlsx"
set "CODE=%ERRORLEVEL%"
echo.
echo Exit code the assistant sees: %CODE%   (0 = approved, 3 = changes requested, 4 = dismissed, 5 = timed out)
pause
