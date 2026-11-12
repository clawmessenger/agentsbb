#requires -Version 5.1
<#
  已弃用的入口（兼容旧文档/旧运维习惯）。
  clawmessenger-daemon.ps1 已更名为 agentsbb-daemon.ps1，本薄壳只打印
  弃用提示并转发全部参数。垫片在 v1.6.0 前后退役。

  Deprecated entry kept so old runbooks keep working: forwards every argument
  to agentsbb-daemon.ps1 next to this file with a bilingual deprecation notice.
  TODO(rebrand-retire): 垫片 v1.6.0 退役时删除本文件
#>
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [object[]]$Forward
)

$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot 'agentsbb-daemon.ps1'
if (-not (Test-Path -LiteralPath $target)) {
  Write-Error "agentsbb-daemon.ps1 not found next to this file: $target"
  exit 1
}
Write-Host '警告：clawmessenger-daemon.ps1 已更名为 agentsbb-daemon.ps1，本入口将在未来一至两个版本移除。' -ForegroundColor Yellow
Write-Host "Warning: clawmessenger-daemon.ps1 has been renamed to agentsbb-daemon.ps1; this shim will be removed in an upcoming release." -ForegroundColor Yellow
& $target @Forward
exit $LASTEXITCODE
