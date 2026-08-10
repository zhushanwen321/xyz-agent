#!/usr/bin/env bash
# pi-unlink.sh — pi 模式：rm globalExtDir symlink + 自动恢复 npm（pi-link 的逆操作）
#
# 做两件事：
#   1. rm ~/.pi/agent/extensions/pi-<short> symlink
#   2. 自动恢复 npm 版本（pi install npm:@zhushanwen/pi-<short>，需联网；失败提示手动）
#
# 用法: ./pi-unlink.sh <package> [package2 ...]
set -euo pipefail

SCOPE="@zhushanwen"
PI_EXT_DIR="$HOME/.pi/agent/extensions"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

resolve_short_name() {
	local input="$1"
	if [[ "$input" == "$SCOPE/"* ]]; then echo "${input#$SCOPE/pi-}"
	elif [[ "$input" == pi-* ]]; then echo "${input#pi-}"
	else echo "$input"; fi
}

# 恢复 npm 版本（pi install，需联网；失败提示手动命令）
restore_npm() {
	local short="$1"
	if command -v pi >/dev/null 2>&1; then
		echo "  恢复 npm 版本..."
		if pi install "npm:$SCOPE/pi-$short" >/dev/null 2>&1; then
			green "  ✓ 已恢复 npm 版本：$SCOPE/pi-$short"
		else
			yellow "  ⚠ 恢复失败（联网问题？），手动：pi install npm:$SCOPE/pi-$short"
		fi
	else
		yellow "  ⚠ pi 命令不可用，手动恢复：pi install npm:$SCOPE/pi-$short"
	fi
}

[ $# -lt 1 ] && { echo "用法: $0 <package> [package2 ...]"; exit 1; }

for input in "$@"; do
	short=$(resolve_short_name "$input")
	link="$PI_EXT_DIR/pi-$short"

	if [ -L "$link" ]; then
		rm "$link"
		green "✓ unlink: ${short}（rm ${link}）"
		restore_npm "$short"
	else
		echo "  · ${short} 未 pi-link（${link} 不是 symlink），跳过"
	fi
done

echo ""
green "✓ pi 模式 unlink 完成"
echo "  生效：新建 pi session（当前 session 仍用已加载的本地版）"
