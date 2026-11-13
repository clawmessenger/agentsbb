@echo off
rem Deprecated alias: clawmessenger-daemon.cmd now forwards to
rem agentsbb-daemon.cmd.
rem TODO(rebrand-retire): delete this file when the shim retires in v1.6.0.
rem
rem English-only on purpose: cmd.exe renders the console in the OEM/ANSI
rem codepage, so a UTF-8 Chinese line would print mojibake unless we flip the
rem codepage (a global side effect on the user's console). The bilingual notice
rem lives in clawmessenger-daemon.ps1, which is UTF-8 with BOM and renders fine.
setlocal
set "SCRIPT=%~dp0agentsbb-daemon.cmd"
if not exist "%SCRIPT%" (
  echo [ERROR] agentsbb-daemon.cmd not found next to this file: "%SCRIPT%"
  exit /b 1
)
echo [DEPRECATED] clawmessenger-daemon.cmd has been renamed to agentsbb-daemon.cmd;
echo              this shim will be removed in an upcoming release.
"%SCRIPT%" %*
endlocal & exit /b %ERRORLEVEL%
