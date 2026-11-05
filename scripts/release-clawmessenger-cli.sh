#!/usr/bin/env bash
#
# release-clawmessenger-cli.sh — 发布 clawmessenger CLI（Windows/Linux/macOS 单文件 exe）。
#
# 发布链路：push tag `clawmessenger-v*.*.*` → GitHub Actions
# (.github/workflows/clawmessenger-release.yml) 在各平台 runner 上用 Node SEA
# 构建 -> 创建 GitHub Release -> 应用内直链
# https://github.com/clawmessenger/claw-messenger/releases/latest/download/clawmessenger-windows-x64.exe
# 即刻生效。
#
# 用法：
#   ./scripts/release-clawmessenger-cli.sh 0.2.1                 # bump 版本 + 提交 + 打 tag + push
#   ./scripts/release-clawmessenger-cli.sh 0.2.1 --no-push       # 只 bump + tag，不推送
#   ./scripts/release-clawmessenger-cli.sh --tag-only            # 不改版本，只推当前 tag
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
  #   version.ts   CLAWMESSENGER_VERSION_FALLBACK —— 未注入时的运行时兜底，
  #                                                  version.test.ts 盯着它与 package.json 一致
  # 以前只改 package.json（version.ts 漏了），测试在 bump 之后跑，脚本自己把自己挡住，
  # 而且 tag 上会留一份「fallback 撒谎」的源码。
  sed -i -E "s/(\"version\":\s*\")[0-9]+\.[0-9]+\.[0-9]+(\")/\1${VERSION}\2/" "${CLI_DIR}/package.json"
  sed -i -E "s/(CLAWMESSENGER_VERSION_FALLBACK = \")[0-9]+\.[0-9]+\.[0-9]+(\")/\1${VERSION}\2/" "${CLI_DIR}/src/version.ts"
  echo "    pkg.json   -> $(grep -m1 -oE '"version":\s*"[0-9.]+"' "${CLI_DIR}/package.json")"
  echo "    version.ts -> $(grep -oE 'CLAWMESSENGER_VERSION_FALLBACK = "[0-9.]+"' "${CLI_DIR}/src/version.ts")"
fi

TAG="clawmessenger-v${VERSION}"
if [[ "${TAG_ONLY}" == true ]]; then
  TAG="$(git describe --tags --abbrev=0 --match 'clawmessenger-v*')"
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
  git tag -a "${TAG}" -m "clawmessenger ${VERSION}"
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
