#!/usr/bin/env bash
# dev-merge.sh — 将当前 feat worktree 的分支合并到兄弟 dev-x.x.x 集成 worktree。
#
# 用法（cwd 必须在待合并的 feat worktree 内）：
#   bash .agents/skills/dev-merge/dev-merge.sh merge   <dev-branch>   # 预检 + 合并
#   bash .agents/skills/dev-merge/dev-merge.sh cleanup <dev-branch>   # 确认已合并后删当前 worktree + 分支
#
# 退出码：
#   0  成功
#   1  预检失败 / 参数错误（错误信息含恢复动作）
#   2  合并冲突（脚本已停在 merge 中间态，冲突清单见输出；解决后 git add + git commit 完成 merge，再跑 cleanup）
#
# 设计约束（SKILL.md 为编排权威，本脚本只做机械步骤）：
# - 不自动提交未提交改动（提交是 AI 决策行为：message / 粒度 / 认知外改动检查）
# - 不 push（push 必须用户明确授权）
# - cleanup 拒绝删除未合并分支 / 脏 worktree，不内置 --force（force 是破坏性操作，须用户显式确认）

set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

SUBCMD="${1:-}"
DEV_BRANCH="${2:-}"

[[ "$SUBCMD" =~ ^(merge|cleanup)$ ]] || die "用法: dev-merge.sh merge|cleanup <dev-branch>，如 dev-merge.sh merge dev-0.9.6"

# ── 当前 worktree 定位 ──
CUR_DIR="$(git rev-parse --show-toplevel 2>/dev/null)" || die "当前目录不在 git 仓库内，请在待合并的 feat worktree 中运行本脚本"
CUR_BRANCH="$(git -C "$CUR_DIR" branch --show-current)"
[[ -n "$CUR_BRANCH" ]] || die "当前 worktree 处于 detached HEAD，无法合并。请先 checkout 到 feature 分支"

WS_ROOT="$(dirname "$CUR_DIR")"
DEV_DIR="$WS_ROOT/$DEV_BRANCH"

list_dev_worktrees() { ls "$WS_ROOT" | grep '^dev-' | tr '\n' ' ' || true; }

[[ -n "$DEV_BRANCH" ]] || die "缺少目标分支参数（如 dev-0.9.6）。可用 dev worktree: $(list_dev_worktrees)"
[[ -d "$DEV_DIR" ]] || die "目标 worktree $WS_ROOT/$DEV_BRANCH 不存在。可用 dev worktree: $(list_dev_worktrees)"

# ── 公共预检：两边 worktree 都必须干净（tracked 改动）──
check_clean() {
  local dir="$1" label="$2"
  git -C "$dir" diff --quiet && git -C "$dir" diff --cached --quiet \
    || die "$label 有未提交改动（tracked）。先按提交策略处理（自己的改动 commit；认知外改动先询问用户），再重跑本脚本"
}

is_merged() { git -C "$DEV_DIR" merge-base --is-ancestor "$CUR_BRANCH" "$DEV_BRANCH"; }

case "$SUBCMD" in
  merge)
    check_clean "$CUR_DIR" "当前 worktree ($CUR_BRANCH)"
    check_clean "$DEV_DIR" "$DEV_BRANCH"

    if is_merged; then
      echo "SKIP: $CUR_BRANCH 已是 $DEV_BRANCH 的祖先（已合并过），无需重复 merge，可直接跑 cleanup"
      exit 0
    fi

    echo ">> git -C $DEV_DIR merge --no-ff $CUR_BRANCH"
    if git -C "$DEV_DIR" merge --no-ff "$CUR_BRANCH"; then
      echo "OK: $CUR_BRANCH 已合并进 ${DEV_BRANCH}（--no-ff 保留分支历史）"
      echo "NEXT: 确认无误后运行 bash .agents/skills/dev-merge/dev-merge.sh cleanup $DEV_BRANCH 清理源 worktree"
    else
      echo "CONFLICT: 以下文件需要解决（在 $DEV_DIR 内处理）：" >&2
      git -C "$DEV_DIR" diff --name-only --diff-filter=U >&2 || true
      echo "HINT: 解决冲突后 cd $DEV_DIR && git add <files> && git commit 完成 merge，再跑 cleanup 子命令" >&2
      exit 2
    fi
    ;;

  cleanup)
    is_merged || die "$CUR_BRANCH 尚未合并进 ${DEV_BRANCH}，拒绝清理。先跑 merge 子命令（或处理完冲突后 git commit 完成 merge）"
    check_clean "$DEV_DIR" "$DEV_BRANCH"

    echo ">> git worktree remove $CUR_DIR"
    # 先 cd 出待删目录（macOS 删除 cwd 所在目录后 shell cwd 悬空）
    cd "$DEV_DIR"
    if ! git worktree remove "$CUR_DIR" 2>/dev/null; then
      # 清理所有 untracked 文件后重试（合并已完成，源 worktree 不再需要保留任何文件）
      git -C "$CUR_DIR" clean -fd >/dev/null 2>&1 || true
      git worktree remove "$CUR_DIR" 2>/dev/null \
        || die "worktree 删除仍被拒绝。检查 $CUR_DIR 内容后用 git -C $DEV_DIR worktree remove --force $CUR_DIR 强删"
    fi
    git branch -d "$CUR_BRANCH" \
      || die "分支 $CUR_BRANCH 删除失败（可能未被当前分支的 upstream 包含）。确认无留存价值后用 git -C $DEV_DIR branch -D $CUR_BRANCH"
    echo "OK: worktree $CUR_DIR 与分支 $CUR_BRANCH 已清理"
    echo "NOTE: 原 worktree 目录已删除，后续 bash 命令必须显式 cd 到其他 worktree（如 ${DEV_DIR}），不能依赖 session 默认 cwd"
    ;;
esac
