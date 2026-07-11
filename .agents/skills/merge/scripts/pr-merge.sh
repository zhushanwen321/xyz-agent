#!/bin/bash
# pr-merge.sh — xyz-agent merge 流程阶段 2：PR CI 等待 + 合并 + sync 本地 main
#
# 做什么：
#   1. 等待 PR CI 通过（最多 10 分钟）
#   2. gh pr merge --merge --delete-branch（merge commit，绝不 squash）
#   3. sync 本地 main（fetch + reset --hard github/main）
#
# 前置：阶段 0（init.sh）已执行，PR 处于 OPEN 状态
# 用法: bash .agents/skills/merge/scripts/pr-merge.sh <branch-name> <pr-number>
# 退出码：0 = 成功，1 = 失败

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

BRANCH_NAME="${1:?Usage: pr-merge.sh <branch-name> <pr-number>}"
PR_NUMBER="${2:?Usage: pr-merge.sh <branch-name> <pr-number>}"

GH_REPO="zhushanwen321/xyz-agent"
GH_REMOTE="github"

PR_STATE=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
PR_TITLE=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json title --jq '.title' 2>/dev/null || echo "")

echo -e "${BOLD}═══ 阶段 2: PR CI + 合并 ═══${NC}"
echo "  PR: #$PR_NUMBER — $PR_TITLE"
echo "  状态: $PR_STATE"

# 幂等：已合并则跳过
if [[ "$PR_STATE" == "MERGED" ]]; then
    echo -e "  ${GREEN}⏭️  PR 已合并，跳过${NC}"
elif [[ "$PR_STATE" != "OPEN" ]]; then
    echo -e "${RED}Error: PR 状态为 $PR_STATE，无法处理（需 OPEN 或 MERGED）${NC}"
    exit 1
else
    # 等待 PR CI
    echo "  检查 PR CI 状态..."
    CI_DATA=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json statusCheckRollup 2>&1) || {
        echo -e "  ${YELLOW}Warning: 无法获取 CI 状态，继续合并${NC}"
        CI_DATA='{"statusCheckRollup":[]}'
    }

    CI_CONCLUSIONS=$(echo "$CI_DATA" | jq -r '[.statusCheckRollup[] | .conclusion] | unique | join(",")' 2>/dev/null || echo "")

    if echo "$CI_CONCLUSIONS" | grep -qi "failure\|timed_out\|cancelled"; then
        echo -e "  ${RED}❌ PR CI 有失败项:${NC}"
        echo "$CI_DATA" | jq -r '.statusCheckRollup[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled") | "    ❌ \(.name) (\(.conclusion))"' 2>/dev/null || true
        exit 1
    fi

    if echo "$CI_CONCLUSIONS" | grep -qi "pending\|queued\|in_progress"; then
        echo "  ⏳ PR CI 仍在运行，等待最多 10 分钟..."
        ELAPSED=0
        while [[ $ELAPSED -lt 600 ]]; do
            sleep 30
            ELAPSED=$((ELAPSED + 30))
            CI_DATA=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json statusCheckRollup 2>&1)
            CI_CONCLUSIONS=$(echo "$CI_DATA" | jq -r '[.statusCheckRollup[] | .conclusion] | unique | join(",")' 2>/dev/null || echo "")
            if ! echo "$CI_CONCLUSIONS" | grep -qi "pending\|queued\|in_progress"; then
                break
            fi
            echo "  ⏳ 等待中... (${ELAPSED}s/600s)"
        done
        if echo "$CI_CONCLUSIONS" | grep -qi "failure\|timed_out\|cancelled"; then
            echo -e "  ${RED}❌ PR CI 失败${NC}"
            exit 1
        fi
    fi

    echo -e "  ${GREEN}✅ PR CI 通过，开始合并${NC}"
    gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --merge --delete-branch 2>&1 || {
        PR_STATE=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
        if [[ "$PR_STATE" == "MERGED" ]]; then
            echo -e "  ${GREEN}PR 已合并（可能被其他进程合并）${NC}"
        else
            echo -e "${RED}Error: PR 合并失败${NC}"
            exit 1
        fi
    }
    echo -e "  ${GREEN}✅ PR #$PR_NUMBER 已合并${NC}"
fi

# sync 本地 main（gh pr merge 直接合到 github/main，不更新本地 main）
echo ""
echo "  sync 本地 main..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WS_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd -P)"
MAIN_WT="$WS_ROOT/main"

git -C "$MAIN_WT" fetch "$GH_REMOTE" main 2>&1 | tail -1
git -C "$MAIN_WT" reset --hard "$GH_REMOTE/main" 2>&1 | tail -1
echo -e "  ${GREEN}✅ 本地 main 已同步到 $GH_REMOTE/main${NC}"
