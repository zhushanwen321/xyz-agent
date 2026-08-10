#!/usr/bin/env bash
# pi-unlink.sh — pi 模式：rm globalExtDir symlink（pi-link 的逆操作）
#
# 做一件事：rm ~/.pi/agent/extensions/pi-<short> symlink。
# 不自动恢复 npm（避免联网；如需恢复跑 'pi install npm:@zhushanwen/pi-<short>'）。
#
# 用法: ./pi-unlink.sh <package> [package2 ...]
set -euo pipefail

SCOPE="@zhushanwen"
PI_EXT_DIR="$HOME/.pi/agent/extensions"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }

resolve_short_name() {
	local input="$1"
	if [[ "$input" == "$SCOPE/"* ]]; then echo "${input#$SCOPE/pi-}"
	elif [[ "$input" == pi-* ]]; then echo "${input#pi-}"
	else echo "$input"; fi
}

[ $# -lt 1 ] && { echo "用法: $0 <package> [package2 ...]"; exit 1; }

for input in "$@"; do
	short=$(resolve_short_name "$input")
	link="$PI_EXT_DIR/pi-$short"

	if [ -L "$link" ]; then
		rm "$link"
		green "✓ unlink: ${short}（rm ${link}）"
	else
		echo "  · ${short} 未 pi-link（${link} 不是 symlink），跳过"
	fi
done

echo ""
green "✓ pi 模式 unlink 完成"
echo "  生效：新建 pi session（当前 session 仍用已加载的本地版）"
echo "  恢复 npm 版（如需）：pi install npm:$SCOPE/pi-<short>（需联网）"
