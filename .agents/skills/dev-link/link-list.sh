#!/usr/bin/env bash
# link-list.sh — 智能检测 dev-link 状态（pi 模式 + xyz-agent 模式）
#
# 增强点（相对旧版）：
#   - source dev-link-lib.sh 复用 PI_EXT_DIR，与 link 建立位置一致
#   - 显示所有 pi-* symlink（不再只过滤 */extensions/* target，pi-statusline 等外部项目也显示）
#   - 悬空 symlink 检测（worktree 删了 link 未清 → ✗ 警告）
#   - worktree 归属标注（[当前worktree] / [其他worktree: name] / [外部]）—— 防"改了不生效"坑
#   - npm 条目备份状态（pi-unlink 会恢复哪些）
#   - PI_CODING_AGENT_DIR 与 link 位置不一致警告（pi 运行时可能不加载）
#
# 路径策略：pi 模式 link 位置由 dev-link-lib.sh 决定（~/.pi/agent/extensions，pi 原生 globalExtDir），
# 本脚本 source lib 保持一致；xyz 模式 .env.dev-extensions 从当前 git root 动态查找。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/dev-link-lib.sh"

ENV_FILE_NAME=".env.dev-extensions"
ENV_VAR="XYZ_EXTENSION_PATHS"
CURRENT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

echo ""
cyan "═══ Dev Link 状态 ═══"
dim "pi agentDir: $(dirname "$PI_EXT_DIR")"
[ -n "$CURRENT_ROOT" ] && dim "当前 worktree: $(basename "$CURRENT_ROOT")"

# 智能提示：PI_CODING_AGENT_DIR 与 link 位置不一致 → pi 运行时读别处，不加载这些 link
if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
	runtime_dir="$(cd "$PI_CODING_AGENT_DIR" 2>/dev/null && pwd || echo "$PI_CODING_AGENT_DIR")"
	link_dir="$(cd "$(dirname "$PI_EXT_DIR")" 2>/dev/null && pwd)"
	if [ "$runtime_dir" != "$link_dir" ]; then
		echo "$(yellow "⚠ PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR 与 link 位置 $(dirname "$PI_EXT_DIR") 不一致")"
		echo "$(yellow "  pi 运行时读 $PI_CODING_AGENT_DIR/extensions/，上述 link 可能不加载")"
	fi
fi
echo ""

# ── pi 模式（原版 pi 生效；symlink 在 PI_EXT_DIR）──
cyan "─── pi 模式（原版 pi 生效）───"
pi_count=0
if [ -d "$PI_EXT_DIR" ]; then
	for link in "$PI_EXT_DIR"/pi-*; do
		[ -L "$link" ] || continue
		name="$(basename "$link")"
		target="$(readlink "$link")"
		pi_count=$((pi_count + 1))
		# 悬空检测（target 不存在 → worktree 删了但 link 未清）
		if [ ! -e "$link" ]; then
			printf "  %s %-22s → %s\n" "$(red '✗悬空')" "$name" "$target"
			continue
		fi
		# worktree 归属
		marker=""
		if [ -n "$CURRENT_ROOT" ]; then
			case "$target" in
				"$CURRENT_ROOT"*) marker="$(green ' [当前worktree]')" ;;
				*/xyz-agent-workspace/*)
					wt_name="$(printf '%s' "$target" | sed 's|.*/xyz-agent-workspace/||; s|/extensions.*||; s|/.*||')"
					marker="$(yellow " [其他worktree: $wt_name]")" ;;
				*) marker="$(dim ' [外部]')" ;;
			esac
		fi
		printf "  %s %-22s → %s%s\n" "$(green '✓')" "$name" "$target" "$marker"
	done
fi
[ "$pi_count" -eq 0 ] && echo "  （无 pi 模式 link）"

# ── xyz-agent 模式（xyz-agent dev 生效；XYZ_EXTENSION_PATHS）──
echo ""
cyan "─── xyz-agent 模式（xyz-agent dev 生效）───"
ENV_FILE=""
if [ -n "$CURRENT_ROOT" ] && [ -f "$CURRENT_ROOT/$ENV_FILE_NAME" ]; then
	ENV_FILE="$CURRENT_ROOT/$ENV_FILE_NAME"
fi
if [ -z "$ENV_FILE" ] || ! grep -q "^${ENV_VAR}=" "$ENV_FILE" 2>/dev/null; then
	echo "  （无 xyz-agent 模式 link）"
else
	CURRENT="$(grep "^${ENV_VAR}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
	echo "$CURRENT" | tr ':' '\n' | while IFS= read -r path; do
		[ -z "$path" ] && continue
		local_name="$(basename "$path")"
		if [ ! -d "$path" ]; then
			printf "  %s %-22s → %s\n" "$(red '✗目录不存在')" "$local_name" "$path"
		else
			marker=""
			[ -n "$CURRENT_ROOT" ] && case "$path" in "$CURRENT_ROOT"*) marker="$(green ' [当前worktree]')" ;; esac
			printf "  %s %-22s → %s%s\n" "$(green '✓')" "$local_name" "$path" "$marker"
		fi
	done
fi

	echo
cyan "提示：pi 模式 → 新 pi session 生效；xyz 模式 → set -a && source .env.dev-extensions && set +a && pnpm dev"
echo ""
