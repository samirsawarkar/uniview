@echo off
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\UniView.exe" "%~dp0app.asar\electron\mcp-entry.mjs" %*
