#!/usr/bin/env bash
# pi-link.sh — pi 模式：切换 extension 到本地源码（原版 pi 直接生效）
#
# 做两件事（切换式，避免多源冲突）：
#   1. pi install <本地源码路径>  — 加本地源到 pi settings
#   2. pi remove npm:@zhushanwen/pi-<short> — 移除 npm 源，让本地成为唯一源
#
# 为何 remove npm：pi resolver dedupe by path 不 by extension id，npm + 本地两源并存
# 会冲突（加载哪个不确定）。切换到唯一本地源最可靠。
#
# 用法: ./pi-link.sh <package> [package2 ...]
#   <package> = 短名 (subagent-workflow) / pi-前缀 / @zhushanwen/pi-全名
#
# 生效条件：新建 pi session（当前 session 已加载旧版，不重扫）。
# 恢复 npm：./pi-unlink.sh <package>
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

	# 1. pi install 本地源码
	if pi install "$ext_dir" >/dev/null 2>&1; then
		green "✓ pi install 本地: ${short} → ${ext_dir}"
	else
		red "✗ pi install 失败: ${ext_dir}（跑 'pi install ${ext_dir}' 看错误）"
		continue
	fi

	# 2. pi remove npm 源（如存在，让本地成为唯一源）
	if pi list 2>/dev/null | grep -q "$npm_src"; then
		if pi remove "$npm_src" >/dev/null 2>&1; then
			echo "  · 移除 npm 源 ${npm_src}（避免多源冲突）"
		else
			yellow "  ⚠ 移除 npm 源失败（保留两源，跑 'pi remove ${npm_src}' 手动处理）"
		fi
	fi
done

echo ""
green "✓ pi 模式 link 完成"
echo "  生效：新建 pi session（当前 session 已加载旧版）"
echo "  验证：pi list（应只剩本地源）；新 session 派 subagent 验证行为"
echo "  恢复：./pi-unlink.sh $*"
