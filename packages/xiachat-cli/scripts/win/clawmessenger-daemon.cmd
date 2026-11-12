@echo off
rem Deprecated alias: clawmessenger-daemon.cmd now forwards to
rem agentsbb-daemon.cmd with a bilingual deprecation notice.
rem TODO(rebrand-retire): 垫片 v1.6.0 退役时删除本文件
setlocal
set "SCRIPT=%~dp0agentsbb-daemon.cmd"
if not exist "%SCRIPT%" (
  echo [ERROR] agentsbb-daemon.cmd not found next to this file: "%SCRIPT%"
  exit /b 1
)
echo 警告：clawmessenger-daemon.cmd 已更名为 agentsbb-daemon.cmd，本入口将在未来一至两个版本移除。
echo Warning: clawmessenger-daemon.cmd has been renamed to agentsbb-daemon.cmd; this shim will be removed in an upcoming release.
"%SCRIPT%" %*
endlocal & exit /b %ERRORLEVEL%
