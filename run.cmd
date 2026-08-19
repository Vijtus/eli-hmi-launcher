@echo off
rem Run the ELI HMI Launcher (L4) from a source checkout on Windows.
rem
rem   run.cmd
rem
rem Thin wrapper: the real logic lives in scripts\run.mjs so that Windows, Linux
rem and macOS all run exactly the same startup path.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [run] ERROR: Node.js not found. Install Node 20.19+ from https://nodejs.org and re-run. 1>&2
  exit /b 1
)

node scripts\run.mjs %*
exit /b %errorlevel%
