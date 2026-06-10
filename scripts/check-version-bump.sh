#!/bin/bash
# 校验代码版本与最新正式 release 一致
# Exit: 0 = 可以安全 bump, 1 = 版本不匹配
set -euo pipefail

REPO="zhushanwen321/xyz-agent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WS_ROOT="${WS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# 获取最新正式 release（排除 draft 和 prerelease）
LATEST=$(gh release list --repo "$REPO" --limit 100 \
  --json tagName,isDraft,isPrerelease \
  | jq -r '.[] | select(.isDraft == false and .isPrerelease == false) | .tagName' \
  | head -1)

if [ -z "$LATEST" ]; then
  echo "ERROR: 未找到任何正式 release"
  exit 1
fi

LATEST_VER="${LATEST#v}"
CURRENT_VER=$(node -p "require('${WS_ROOT}/package.json').version")

if [ "$LATEST_VER" != "$CURRENT_VER" ]; then
  echo "ERROR: 版本不匹配！"
  echo "  最新正式 release: v${LATEST_VER}"
  echo "  当前代码版本:     v${CURRENT_VER}"
  echo ""
  echo "当前代码版本必须等于最新正式 release 版本。"
  echo "Bump 后才能保证新版本 = ${LATEST_VER} + 1。"
  echo ""
  echo "如果当前代码版本已经大于最新 release，可能是："
  echo "  1. 有 draft/prerelease 占用了目标版本号"
  echo "  2. 已经手动 bump 过版本"
  echo "  3. 需要先还原到 ${LATEST_VER} 再重新 bump"
  exit 1
fi

echo "OK: 当前代码版本 (${CURRENT_VER}) == 最新正式 release (${LATEST_VER})"
echo "可以执行版本 bump。"
