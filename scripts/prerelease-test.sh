#!/bin/bash
# 预发布测试：创建 -beta.N 版本触发 CI，验证产物，还原代码
# Usage: bash scripts/prerelease-test.sh
set -euo pipefail

REPO="zhushanwen321/xyz-agent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WS_ROOT="${WS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
GITHUB_REMOTE="github"
CI_TIMEOUT_MINS=30
POLL_INTERVAL=20

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[PRERELEASE]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }

cleanup_on_failure() {
  warn "清理 beta tag 和 release..."
  cd "$WS_ROOT"
  git reset --hard HEAD~1 2>/dev/null || true
  git push "$GITHUB_REMOTE" HEAD --force-with-lease 2>/dev/null || true
  git push "$GITHUB_REMOTE" --delete "$BETA_TAG" 2>/dev/null || true
  gh release delete "$BETA_TAG" --repo "$REPO" --yes 2>/dev/null || true
  log "版本已还原到 ${ORIGINAL_VERSION}"
}

# ── 阶段 1/6: 前置检查 ──
log "=== 阶段 1/6: 前置检查 ==="

BRANCH=$(git -C "$WS_ROOT" branch --show-current)
if [ "$BRANCH" != "main" ]; then
  err "必须在 main 分支上运行，当前: $BRANCH"
  exit 1
fi

if ! git -C "$WS_ROOT" diff-index --quiet HEAD --; then
  err "工作区不干净，请先 commit 或 stash"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  err "gh CLI 未认证，请先运行 gh auth login"
  exit 1
fi

log "前置检查通过: main 分支, 工作区干净, gh 已认证"

# ── 阶段 2/6: 计算 beta 版本号 ──
log "=== 阶段 2/6: 计算 beta 版本号 ==="

# 2a. 获取最新正式 release
LATEST=$(gh release list --repo "$REPO" --limit 100 \
  --json tagName,isDraft,isPrerelease \
  | jq -r '.[] | select(.isDraft == false and .isPrerelease == false) | .tagName' \
  | head -1)

if [ -z "$LATEST" ]; then
  err "未找到正式 release"
  exit 1
fi
LATEST_VER="${LATEST#v}"
log "最新正式 release: v${LATEST_VER}"

# 2b. 确认代码版本匹配
CURRENT_VER=$(node -p "require('${WS_ROOT}/package.json').version")
if [ "$LATEST_VER" != "$CURRENT_VER" ]; then
  err "代码版本 (${CURRENT_VER}) != 最新 release (${LATEST_VER})"
  exit 1
fi

# 2c. 计算下一个正式版本号（默认 patch +1）
IFS='.' read -r MAJOR MINOR PATCH <<< "$LATEST_VER"
NEXT_PATCH=$((PATCH + 1))
BASE_NEXT="${MAJOR}.${MINOR}.${NEXT_PATCH}"

# 2d. 检测已有 beta 版本，递增序号
EXISTING_BETA=$(gh release list --repo "$REPO" --limit 100 \
  --json tagName,isPrerelease \
  | jq -r --arg prefix "v${BASE_NEXT}-beta." \
    '.[] | select(.isPrerelease == true) | .tagName | select(startswith($prefix))' \
  | sort -V | tail -1)

if [ -n "$EXISTING_BETA" ]; then
  LAST_NUM=$(echo "$EXISTING_BETA" | sed 's/.*-beta\.//')
  BETA_NUM=$((LAST_NUM + 1))
else
  BETA_NUM=1
fi

BETA_VERSION="${BASE_NEXT}-beta.${BETA_NUM}"
BETA_TAG="v${BETA_VERSION}"
ORIGINAL_VERSION="$CURRENT_VER"
log "beta 版本: ${BETA_TAG}"

# ── 阶段 3/6: Bump + Push ──
log "=== 阶段 3/6: Bump 版本并推送 ==="

cd "$WS_ROOT"
npm version "$BETA_VERSION" --no-git-tag-version 1>/dev/null
cd src-electron
npm version "$BETA_VERSION" --no-git-tag-version 1>/dev/null
cd "$WS_ROOT"

git add package.json src-electron/package.json
git commit -m "chore: prerelease ${BETA_TAG}"
git tag "$BETA_TAG"
git push "$GITHUB_REMOTE" HEAD
git push "$GITHUB_REMOTE" "$BETA_TAG"

log "Tag ${BETA_TAG} 已推送，CI 开始构建..."

# ── 阶段 4/6: 等待 CI 完成 ──
log "=== 阶段 4/6: 等待 CI 完成（超时: ${CI_TIMEOUT_MINS} 分钟）==="

MAX_POLLS=$((CI_TIMEOUT_MINS * 60 / POLL_INTERVAL))
CI_FAILED=0

for i in $(seq 1 "$MAX_POLLS"); do
  # 轮询 release 是否存在（CI 最后一步会创建）
  if gh release view "$BETA_TAG" --repo "$REPO" --json isDraft --jq '.isDraft' &>/dev/null; then
    log "Release ${BETA_TAG} 已创建，CI 构建完成"
    break
  fi

  # 检查是否有 workflow run 失败
  FAILED_RUN=$(gh run list --repo "$REPO" --workflow Release --limit 5 \
    --json headBranch,conclusion,databaseId \
    | jq -r ".[] | select(.headBranch == \"${BETA_TAG}\" and .conclusion == \"failure\") | .databaseId" \
    | head -1) || true

  if [ -n "$FAILED_RUN" ]; then
    err "CI 构建失败！"
    err "详情: https://github.com/${REPO}/actions/runs/${FAILED_RUN}"
    CI_FAILED=1
    break
  fi

  log "等待 CI 完成... ($i/$MAX_POLLS)"
  sleep "$POLL_INTERVAL"
done

if [ "$CI_FAILED" -eq 1 ]; then
  cleanup_on_failure
  exit 1
fi

# 检查是否超时
if ! gh release view "$BETA_TAG" --repo "$REPO" --json isDraft --jq '.isDraft' &>/dev/null; then
  err "CI 超时（${CI_TIMEOUT_MINS} 分钟），请手动检查"
  warn "https://github.com/${REPO}/actions"
  exit 1
fi

# ── 阶段 5/6: 验证产物 ──
log "=== 阶段 5/6: 验证产物 ==="

# 等待 assets 上传完成（release 创建后 assets 可能还在上传）
for i in $(seq 1 6); do
  ASSETS=$(gh release view "$BETA_TAG" --repo "$REPO" --json assets \
    --jq '.assets[].name' 2>/dev/null || echo "")
  ASSET_COUNT=$(echo "$ASSETS" | grep -c '.' || echo 0)
  if [ "$ASSET_COUNT" -ge 3 ]; then
    break
  fi
  log "等待产物上传... ($i/6, 当前 $ASSET_COUNT 个)"
  sleep 10
done

if [ -z "$ASSETS" ]; then
  warn "未找到任何产物，请手动检查"
  warn "  https://github.com/${REPO}/releases/tag/${BETA_TAG}"
else
  echo ""
  echo "产物列表:"
  echo "$ASSETS"
  echo ""

  MISSING=0
  echo "$ASSETS" | grep -q "\.dmg$" || { warn "缺少 macOS .dmg"; MISSING=1; }
  echo "$ASSETS" | grep -q "\.exe$" || { warn "缺少 Windows .exe"; MISSING=1; }
  echo "$ASSETS" | grep -q "AppImage" || { warn "缺少 Linux AppImage"; MISSING=1; }

  if [ "$MISSING" -eq 0 ]; then
    log "所有平台产物已生成 (dmg + exe + AppImage)"
  fi
fi

# ── 阶段 6/6: 还原版本 ──
log "=== 阶段 6/6: 还原版本 ==="

echo ""
warn "产物已生成，请下载并测试:"
warn "  https://github.com/${REPO}/releases/tag/${BETA_TAG}"
echo ""

read -p "测试通过？输入 yes 还原版本并清理 (输入 no 保留 beta): " CONFIRM

if [ "$CONFIRM" = "yes" ]; then
  cd "$WS_ROOT"

  # 还原代码版本（使用 --force-with-lease 防止覆盖他人提交）
  git reset --hard HEAD~1
  git push "$GITHUB_REMOTE" HEAD --force-with-lease

  # 删除 beta tag（本地和远程）
  git tag -d "$BETA_TAG" 2>/dev/null || true
  git push "$GITHUB_REMOTE" --delete "$BETA_TAG" 2>/dev/null || true

  # 删除 beta release
  gh release delete "$BETA_TAG" --repo "$REPO" --yes 2>/dev/null || true

  log "完成: 版本已还原到 ${ORIGINAL_VERSION}，beta tag 和 release 已清理"
else
  log "保留 beta 版本 ${BETA_TAG}，未还原代码版本"
  log "手动还原: git reset --hard HEAD~1 && git push github HEAD --force-with-lease"
fi
