#!/bin/bash
# npm 预发布：创建 dev-npm-* 分支 → changeset prerelease → push 触发 CI → 验证 npm 版本 → 还原
# Usage: bash scripts/npm-prerelease.sh
#
# 前置条件：
#   - npm 已创建 @xyz-agent scope
#   - GitHub repo 有 NPM_TOKEN secret
#   - changeset 已初始化（.changeset/config.json 存在）
set -euo pipefail

# 检查失败原则：任何非 0 退出都输出
trap '[ $? -ne 0 ] && echo "[原则] 预发布失败，请检查上方错误信息。可手动还原：git checkout main && git branch -D dev-npm-*" >&2' EXIT

REPO="zhushanwen321/xyz-agent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WS_ROOT="${WS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
GITHUB_REMOTE="github"
CI_TIMEOUT_MINS=15
POLL_INTERVAL=15

# 发布的包名（目前只发这一个，后续扩展可改为参数）
PKG_NAME="@xyz-agent/extension-protocol"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[NPM-PRE]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }
info() { echo -e "${CYAN}[INFO]${NC} $*"; }

# ── 阶段 1/6: 前置检查 ──
log "=== 阶段 1/6: 前置检查 ==="

ORIGINAL_BRANCH=$(git -C "$WS_ROOT" branch --show-current)
if [ "$ORIGINAL_BRANCH" != "main" ]; then
  err "当前在 ${ORIGINAL_BRANCH} 分支（非 main），请先切到 main"
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

if [ ! -f "$WS_ROOT/.changeset/config.json" ]; then
  err "changeset 未初始化（缺少 .changeset/config.json）"
  exit 1
fi

# 确认 origin/main 是最新
git -C "$WS_ROOT" fetch "$GITHUB_REMOTE" main --quiet 2>/dev/null || true
if ! git -C "$WS_ROOT" diff --quiet HEAD "$GITHUB_REMOTE/main" -- 2>/dev/null; then
  warn "本地 main 与 github/main 有差异，建议先同步"
fi

log "前置检查通过: main 分支, 工作区干净, gh 已认证, changeset 已初始化"

# ── 阶段 2/6: 创建 dev 分支 + 生成 prerelease changeset ──
log "=== 阶段 2/6: 生成 prerelease changeset ==="

cd "$WS_ROOT"

# 记录原始版本号（用于还原）
ORIGINAL_VERSION=$(node -p "require('./packages/extension-protocol/package.json').version")
log "当前 ${PKG_NAME} 版本: ${ORIGINAL_VERSION}"

# 创建 dev 分支（带时间戳，避免分支名冲突）
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEV_BRANCH="dev-npm-${TIMESTAMP}"
log "创建 dev 分支: ${DEV_BRANCH}"
git checkout -b "$DEV_BRANCH"

# 生成 prerelease changeset（交互式 changeset 不适合自动化，直接写文件）
CHANGESET_FILE=".changeset/prerelease-${TIMESTAMP}.md"
cat > "$CHANGESET_FILE" << EOF
---
"@xyz-agent/extension-protocol": patch
---

Prerelease build for testing.
EOF

log "生成 changeset: ${CHANGESET_FILE}"

# 进入 prerelease 模式
info "进入 changeset prerelease 模式（prerelease tag: dev）..."
pnpm changeset pre enter dev 2>&1 | tail -3

# 消费 changeset，生成版本号
info "执行 changeset version..."
pnpm changeset version 2>&1 | tail -5

# 读取生成的版本号
NEW_VERSION=$(node -p "require('./packages/extension-protocol/package.json').version")
log "prerelease 版本: ${ORIGINAL_VERSION} → ${NEW_VERSION}"

# ── 阶段 3/6: commit + push 触发 CI ──
log "=== 阶段 3/6: commit + push 触发 CI ==="

cd "$WS_ROOT"
git add -A
git commit -m "chore: npm prerelease ${PKG_NAME}@${NEW_VERSION}" 2>&1 | tail -3

git push "$GITHUB_REMOTE" "$DEV_BRANCH" 2>&1 | tail -3
log "分支 ${DEV_BRANCH} 已推送，CI 开始构建..."

# ── 阶段 4/6: 等待 CI 完成 ──
log "=== 阶段 4/6: 等待 CI 完成（超时: ${CI_TIMEOUT_MINS} 分钟）==="

MAX_POLLS=$((CI_TIMEOUT_MINS * 60 / POLL_INTERVAL))
CI_DONE=0

for i in $(seq 1 "$MAX_POLLS"); do
  # 查询 CI run 状态
  RUN_STATUS=$(gh run list \
    --workflow=release-npm-dev.yml \
    --branch="$DEV_BRANCH" \
    --repo "$REPO" \
    --limit 1 \
    --json status,conclusion \
    --jq '.[0] // {}' 2>/dev/null || echo '{}')

  STATUS=$(echo "$RUN_STATUS" | jq -r '.status // empty')
  CONCLUSION=$(echo "$RUN_STATUS" | jq -r '.conclusion // empty')

  if [ "$STATUS" = "completed" ]; then
    if [ "$CONCLUSION" = "success" ]; then
      log "CI 构建成功"
      CI_DONE=1
      break
    else
      err "CI 构建失败: conclusion=${CONCLUSION}"
      err "查看日志: https://github.com/${REPO}/actions"
      exit 1
    fi
  fi

  log "等待 CI 完成... ($i/$MAX_POLLS, status=${STATUS:-pending})"
  sleep "$POLL_INTERVAL"
done

if [ "$CI_DONE" -ne 1 ]; then
  err "CI 超时（${CI_TIMEOUT_MINS} 分钟）"
  err "查看: https://github.com/${REPO}/actions"
  exit 1
fi

# ── 阶段 5/6: 验证 npm 版本 ──
log "=== 阶段 5/6: 验证 npm 版本 ==="

# [HISTORICAL] 用 curl 查官方 registry 而非 npm view：
# npm view 受本地 registry 配置影响（如 npmmirror 镜像），镜像同步新包有延迟，
# 导致脚本误报「验证失败」。curl 直接查 registry.npmjs.org 是 publish 的真实目标。
NPM_REGISTRY="https://registry.npmjs.org"
PKG_URL="${NPM_REGISTRY}/$(echo "$PKG_NAME" | sed 's|/|%2f|')/${NEW_VERSION}"

NPM_VERIFIED=0
for i in $(seq 1 10); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$PKG_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    log "npm 验证通过: ${PKG_NAME}@${NEW_VERSION} 已在官方 registry 上线"
    NPM_VERIFIED=1
    break
  fi
  info "等待 npm registry 同步... ($i/10, HTTP $HTTP_CODE)"
  sleep 10
done

if [ "$NPM_VERIFIED" -ne 1 ]; then
  warn "npm 版本未确认上线（预期 ${NEW_VERSION}）"
  warn "可能是 registry 延迟，手动验证: curl -s ${PKG_URL}"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
info "npm 预发布成功！"
echo ""
echo "  包: ${PKG_NAME}"
echo "  版本: ${NEW_VERSION}（dev dist-tag）"
echo "  安装: npm install ${PKG_NAME}@dev"
echo "  npm:  https://www.npmjs.com/package/${PKG_NAME}"
echo "════════════════════════════════════════════════════════════"
echo ""

# ── 阶段 6/6: 还原 ──
log "=== 阶段 6/6: 还原 ==="

read -p "测试通过？输入 yes 还原代码（保留 npm dev tag），输入 no 保留 dev 分支: " CONFIRM

if [ "$CONFIRM" = "yes" ]; then
  cd "$WS_ROOT"

  # 切回 main
  git checkout main

  # 删除本地 dev 分支（分支上的 version bump 不影响 main）
  git branch -D "$DEV_BRANCH"

  # 删除远程 dev 分支
  git push "$GITHUB_REMOTE" --delete "$DEV_BRANCH" 2>/dev/null || true

  # 退出 prerelease 模式（清理 .changeset/pre.json）
  pnpm changeset pre exit 2>&1 | tail -3 || true

  # 清理可能残留的 prerelease changeset 文件
  rm -f "$CHANGESET_FILE"

  log "完成: 代码已还原到 main，dev 分支已清理，npm dev tag 保留"
  log "  ${PKG_NAME} 版本回到 ${ORIGINAL_VERSION}（main 分支）"
else
  log "保留 dev 分支 ${DEV_BRANCH}"
  log "手动还原:"
  log "  git checkout main && git branch -D $DEV_BRANCH"
  log "  git push $GITHUB_REMOTE --delete $DEV_BRANCH"
  log "  pnpm changeset pre exit"
fi
