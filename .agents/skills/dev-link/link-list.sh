#!/usr/bin/env bash
# link-list.sh — 查看 extension link 状态（pi 模式 + xyz-agent 模式）
# 用法: ./link-list.sh
set -euo pipefail

ENV_FILE_NAME=".env.dev-extensions"
ENV_VAR="XYZ_EXTENSION_PATHS"

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }

GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "不在 git 仓库中"; exit 2; })"
ENV_FILE="$GIT_ROOT/$ENV_FILE_NAME"

echo ""
cyan "═══ Dev Link 状态 ═══"

# ── pi 模式（~/.pi/agent/extensions/ symlink，指向 worktree 源码）──
echo ""
cyan "─── pi 模式（~/.pi/agent/extensions/ symlink；原版 pi 生效）───"
pi_links=""
for link in "$HOME/.pi/agent/extensions"/pi-*; do
	[ -L "$link" ] || continue
	target=$(readlink "$link")
	case "$target" in
		*/extensions/*) pi_links="${pi_links}  ✓ $(basename "$link") → ${target}\n" ;;
	esac
done
if [ -n "$pi_links" ]; then
	printf "%b" "$pi_links"
else
	echo "  （无 pi 模式 link）"
fi

# ── xyz-agent 模式（.env.dev-extensions）──
echo ""
cyan "─── xyz-agent 模式（XYZ_EXTENSION_PATHS；xyz-agent dev 生效）───"
if [ ! -f "$ENV_FILE" ] || ! grep -q "^${ENV_VAR}=" "$ENV_FILE" 2>/dev/null; then
	echo "  （无 xyz-agent 模式 link）"
else
	CURRENT=$(grep "^${ENV_VAR}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
	if [ -n "$CURRENT" ]; then
		echo "$CURRENT" | tr ':' '\n' | while IFS= read -r path; do
			[ -z "$path" ] && continue
			local_name=$(basename "$path")
			if [ ! -d "$path" ]; then
				printf "  ✗ %-20s → %s (目录不存在，link-npm.sh 清理)\n" "$local_name" "$path"
			else
				printf "  ✓ %-20s → %s\n" "$local_name" "$path"
			fi
		done
	fi
fi

echo ""
cyan "提示：pi 模式 → 新 pi session 生效；xyz 模式 → source .env.dev-extensions && pnpm dev 生效"
echo ""
