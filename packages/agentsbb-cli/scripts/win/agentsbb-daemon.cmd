@echo off
rem agentsbb background daemon - thin wrapper that forwards to the
rem PowerShell script sitting next to it. See CLAWMESSENGER_GUIDE.zh.md (Appendix A).
rem
rem   agentsbb-daemon.cmd start            start in background (survives closing the window)
rem   agentsbb-daemon.cmd stop             stop everything
rem   agentsbb-daemon.cmd restart          restart
rem   agentsbb-daemon.cmd status           show status
rem   agentsbb-daemon.cmd logs             tail the log
rem   agentsbb-daemon.cmd install-startup  silent auto-start on logon (no admin needed)
rem   agentsbb-daemon.cmd install          scheduled-task auto-start (needs admin)
rem   agentsbb-daemon.cmd uninstall        remove auto-start
setlocal
set "SCRIPT=%~dp0agentsbb-daemon.ps1"
if not exist "%SCRIPT%" (
  echo [ERROR] agentsbb-daemon.ps1 not found next to this file: "%SCRIPT%"
  exit /b 1
)
if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Action status
  echo.
  echo usage: agentsbb-daemon.cmd start / stop / restart / status / logs
  echo        agentsbb-daemon.cmd install-startup / install / uninstall
  echo        extra args are passed through, e.g.:  ... start -Model gpt-5
  pause
  exit /b 0
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %errorlevel%
