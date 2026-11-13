#!/usr/bin/env bash
# Deprecated alias: clawmessenger-daemon.sh now forwards to agentsbb-daemon.sh
# with a bilingual deprecation notice.
# TODO(rebrand-retire): 垫片 v1.6.0 退役时删除本文件
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="$here/agentsbb-daemon.sh"
if [ ! -x "$target" ]; then
  echo "error: agentsbb-daemon.sh not found next to this file: $target" >&2
  exit 1
fi
echo '警告：clawmessenger-daemon.sh 已更名为 agentsbb-daemon.sh，本入口将在未来一至两个版本移除。' >&2
echo 'Warning: clawmessenger-daemon.sh has been renamed to agentsbb-daemon.sh; this shim will be removed in an upcoming release.' >&2
exec "$target" "$@"
