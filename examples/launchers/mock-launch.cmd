@echo off
setlocal
set "NAME=%~1"
if "%NAME%"=="" set "NAME=Unknown target"
if "%TEMP%"=="" set "TEMP=%CD%"
set "LOG_FILE=%TEMP%\eli-hmi-launcher-mock.log"
echo %DATE% %TIME% Mock launch: %NAME%>> "%LOG_FILE%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Mock launch: %NAME%','ELI Launcher mock')" >nul 2>nul
exit /b 0
