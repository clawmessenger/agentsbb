#!/usr/bin/env bash
#
# release-agentsbb-cli.sh — 发布 AgentsBB CLI（Windows/Linux/macOS 单文件 exe）。
#
# 发布链路：push tag `agentsbb-v*.*.*` → GitHub Actions
# (.github/workflows/agentsbb-release.yml) 在各平台 runner 上用 Node SEA
# 构建 -> 创建 GitHub Release -> 应用内直链
# https://github.com/clawmessenger/claw-messenger/releases/latest/download/agentsbb-windows-x64.exe
# 即刻生效。
#
# 过渡期双名单：release 同时上传 `agentsbb-*`（新）与 `clawmessenger-*`（旧）两套资产，
# 供尚未升级的 1.3.x 客户端自更新；tag 也接受 `clawmessenger-v*.*.*` 触发。
# 旧名单在 v1.6.0 随 `clawmessenger` 垫片一并退役，届时只删本脚本里带
# TODO(rebrand-retire) 的两处 --match 与 workflow 的旧前缀触发即可。
#
# 用法：
#   ./scripts/release-agentsbb-cli.sh 0.2.1                 # bump 版本 + 提交 + 打 tag + push
#   ./scripts/release-agentsbb-cli.sh 0.2.1 --no-push       # 只 bump + tag，不推送
#   ./scripts/release-agentsbb-cli.sh --tag-only            # 不改版本，只推当前 tag
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_DIR="${REPO_ROOT}/packages/xiachat-cli"
cd "${REPO_ROOT}"

TAG_ONLY=false
NO_PUSH=false
VERSION=""
for arg in "$@"; do
  case "${arg}" in
    --tag-only) TAG_ONLY=true ;;
    --no-push)  NO_PUSH=true ;;
    -*)         echo "unknown flag: ${arg}" >&2; exit 2 ;;
    *)          VERSION="${arg}" ;;
  esac
done

if [[ "${TAG_ONLY}" == false ]]; then
  [[ -n "${VERSION}" ]] || { echo "usage: $0 <version> [--no-push] | --tag-only" >&2; exit 2; }
  echo "==> bumping xiachat-cli to ${VERSION}"
  # 版本号只剩**两处**硬编码（main.ts 早已改走 cliVersion()，没有字面量了）：
  #   package.json "version"                      —— 构建脚本的默认来源
  #   version.ts   AGENTSBB_VERSION_FALLBACK      —— 未注入时的运行时兜底，
  #                                                  version.test.ts 盯着它与 package.json 一致
  # 以前只改 package.json（version.ts 漏了），测试在 bump 之后跑，脚本自己把自己挡住，
  # 而且 tag 上会留一份「fallback 撒谎」的源码。
  sed -i -E "s/(\"version\":\s*\")[0-9]+\.[0-9]+\.[0-9]+(\")/\1${VERSION}\2/" "${CLI_DIR}/package.json"
  sed -i -E "s/(AGENTSBB_VERSION_FALLBACK = \")[0-9]+\.[0-9]+\.[0-9]+(\")/\1${VERSION}\2/" "${CLI_DIR}/src/version.ts"
  echo "    pkg.json   -> $(grep -m1 -oE '"version":\s*"[0-9.]+"' "${CLI_DIR}/package.json")"
  echo "    version.ts -> $(grep -oE 'AGENTSBB_VERSION_FALLBACK = "[0-9.]+"' "${CLI_DIR}/src/version.ts")"
fi

TAG="agentsbb-v${VERSION}"
if [[ "${TAG_ONLY}" == true ]]; then
  # 优先取最新的 agentsbb-v*；仓库历史上只有 clawmessenger-v* 时（首次改名发布之前）
  # 回退到旧前缀，避免 --tag-only 在第一个新 tag 打出来之前直接报错。
  TAG="$(git describe --tags --abbrev=0 --match 'agentsbb-v*' 2>/dev/null || true)"
  if [[ -z "${TAG}" ]]; then
    # TODO(rebrand-retire): 旧 tag 前缀兼容，v1.6.0 垫片退役时一并删除。
    TAG="$(git describe --tags --abbrev=0 --match 'clawmessenger-v*' 2>/dev/null || true)"
    if [[ -n "${TAG}" ]]; then
      echo "!! 只找到旧前缀 tag ${TAG}；建议先发一个 agentsbb-v* 版本" >&2
    fi
  fi
  [[ -n "${TAG}" ]] || { echo "!! 没有任何 agentsbb-v* tag，先跑 $0 <version>" >&2; exit 1; }
  echo "==> tag-only: using existing tag ${TAG}"
fi

if [[ "${TAG_ONLY}" == false ]]; then
  echo "==> running CLI tests + typecheck"
  ( cd "${CLI_DIR}" && pnpm typecheck && pnpm test )

  if ! git diff --quiet -- "${CLI_DIR}/package.json" "${CLI_DIR}/src/version.ts"; then
    echo "==> committing version bump"
    git add "${CLI_DIR}/package.json" "${CLI_DIR}/src/version.ts"
    git commit -m "chore(cli): bump xiachat-cli to ${VERSION}"
  fi

  if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    echo "!! tag ${TAG} already exists locally" >&2; exit 1
  fi
  echo "==> creating tag ${TAG}"
  git tag -a "${TAG}" -m "agentsbb ${VERSION}"
fi

if [[ "${NO_PUSH}" == true ]]; then
  echo "==> --no-push set; push manually:"
  echo "    git push origin main && git push origin ${TAG}"
  exit 0
fi

echo "==> pushing main + ${TAG} (this triggers the release workflow)"
git push origin main
git push origin "${TAG}"
echo "==> done. Watch the run: https://github.com/clawmessenger/claw-messenger/actions"
