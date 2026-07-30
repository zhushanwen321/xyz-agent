#!/usr/bin/env bash
# link-list.sh — 查看当前 extension link 状态
# 用法: ./link-list.sh
set -euo pipefail

ENV_FILE_NAME=".env.dev-extensions"
ENV_VAR="XYZ_EXTENSION_PATHS"

# ── 颜色输出 ────────────────────────────────────────────
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }

# ── 定位项目根目录 ──────────────────────────────────────
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "不在 git 仓库中"; exit 2; })"
ENV_FILE="$GIT_ROOT/$ENV_FILE_NAME"

echo ""
cyan "═══ Dev Link 状态 ═══"
echo ""

if [ ! -f "$ENV_FILE" ]; then
	yellow "无 link（$ENV_FILE_NAME 不存在）"
	echo ""
	echo "  link 一个 extension: bash .agents/skills/dev-link/link-local.sh <package>"
	exit 0
fi

if ! grep -q "^${ENV_VAR}=" "$ENV_FILE" 2>/dev/null; then
	yellow "$ENV_FILE_NAME 存在但 $ENV_VAR 未设置"
	echo ""
	echo "  $ENV_FILE_NAME 内容:"
	cat "$ENV_FILE"
	exit 0
fi

# 读取并解析 XYZ_EXTENSION_PATHS
CURRENT=$(grep "^${ENV_VAR}=" "$ENV_FILE" | head -1 | cut -d= -f2-)

if [ -z "$CURRENT" ]; then
	yellow "$ENV_VAR 为空"
	exit 0
fi

green "已 link 的 extension（${ENV_VAR}）："
echo ""

# 逐个路径显示 + 检查是否存在 + 是否有改动
echo "$CURRENT" | tr ':' '\n' | while IFS= read -r path; do
	if [ -z "$path" ]; then continue; fi

	# 提取短名（从路径最后一段）
	local_name=$(basename "$path")

	if [ ! -d "$path" ]; then
		printf "  ✗ %-20s → %s\n" "$local_name" "$path"
		echo "    ⚠ 目录不存在（worktree 已删除？请 link-npm.sh 清理）"
	elif [ ! -f "$path/package.json" ]; then
		printf "  ⚠ %-20s → %s\n" "$local_name" "$path"
		echo "    缺少 package.json"
	else
		# 检查是否有未提交的改动
		if [ -d "$path/.git" ] || git -C "$path" rev-parse --git-dir &>/dev/null; then
			if git -C "$GIT_ROOT" diff --quiet -- "$path" 2>/dev/null; then
				printf "  ✓ %-20s → %s\n" "$local_name" "$path"
			else
				printf "  ✎ %-20s → %s (有未提交改动)\n" "$local_name" "$path"
			fi
		else
			printf "  ✓ %-20s → %s\n" "$local_name" "$path"
		fi
	fi
done

echo ""
cyan "启动命令: set -a && source $ENV_FILE_NAME && set +a && pnpm dev"
echo ""
