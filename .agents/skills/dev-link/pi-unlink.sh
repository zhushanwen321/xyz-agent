#!/usr/bin/env bash
# pi-unlink.sh — pi 模式：恢复 extension 到 npm 源（pi-link 的逆操作）
#
# 做两件事：
#   1. pi remove <本地源码路径>  — 移除本地源
#   2. pi install npm:@zhushanwen/pi-<short> — 恢复 npm 源
#
# 用法: ./pi-unlink.sh <package> [package2 ...]
#   <package> = 短名 (subagent-workflow) / pi-前缀 / @zhushanwen/pi-全名
#
# 注意：pi install npm 需联网（npm install）。离线环境恢复会失败。
set -euo pipefail

SCOPE="@zhushanwen"
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { printf "\033[31m✗ 不在 git 仓库\033[0m\n"; exit 2; })"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

resolve_short_name() {
	local input="$1"
	if [[ "$input" == "$SCOPE/"* ]]; then echo "${input#$SCOPE/pi-}"
	elif [[ "$input" == pi-* ]]; then echo "${input#pi-}"
	else echo "$input"; fi
}

find_extension_dir() {
	local short="$1"
	for dir in "$GIT_ROOT/extensions/$short" "$GIT_ROOT/extensions/shared/$short"; do
		if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then echo "$dir"; return 0; fi
	done
	return 1
}

[ $# -lt 1 ] && { echo "用法: $0 <package> [package2 ...]"; exit 1; }

for input in "$@"; do
	short=$(resolve_short_name "$input")
	ext_dir=$(find_extension_dir "$short") || { red "✗ 找不到 extension 目录: extensions/${short}"; continue; }
	npm_src="npm:$SCOPE/pi-$short"

	# 1. pi remove 本地源（如存在）
	if pi list 2>/dev/null | grep -qF "$ext_dir"; then
		pi remove "$ext_dir" >/dev/null 2>&1 && green "✓ pi remove 本地: ${short}"
	else
		echo "  · ${short} 未 pi-link（本地源不在 pi list），跳过 remove"
	fi

	# 2. pi install npm 源（恢复，如尚未存在）
	if ! pi list 2>/dev/null | grep -q "$npm_src"; then
		if pi install "$npm_src" >/dev/null 2>&1; then
			echo "  · 恢复 npm 源 ${npm_src}"
		else
			red "  ⚠ 恢复 npm 源失败（需联网）：跑 'pi install ${npm_src}' 手动恢复"
		fi
	else
		echo "  · npm 源 ${npm_src} 已存在，跳过"
	fi
done

echo ""
green "✓ pi 模式 unlink 完成"
echo "  生效：新建 pi session（当前 session 仍用已加载的本地版）"
