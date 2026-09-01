@echo off
setlocal
set "SCRIPT=%~dp0repair-hermes-acp.ps1"
if not exist "%SCRIPT%" (
  echo Missing repair-hermes-acp.ps1
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
