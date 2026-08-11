#!/usr/bin/env bash
# pi-unlink.sh — pi 模式：rm globalExtDir symlink + 恢复 npm 条目（pi-link 的逆操作）
#
# 做两件事：
#   1. rm ~/.pi/agent/extensions/pi-<short> symlink
#   2. 恢复 pi-link 时备份的 settings.json packages 条目（读 ~/.pi/agent/.pi-link-backup.json，
#      写回后删除备份记录）。纯本地操作，无需联网。
#
# 状态守恒：pi-link 删掉的 npm 条目在 unlink 时自动还原 → 往返后 extension 回到 npm 源。
# 注意：恢复的是「被 pi-link 清理掉」的条目；从未 link 过、备份里没有的包不受影响。
#
# 用法: ./pi-unlink.sh <package> [package2 ...]
#   <package> = 短名 (subagent-workflow) / pi-前缀 / @zhushanwen/pi-全名
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dev-link-lib.sh
source "$SCRIPT_DIR/dev-link-lib.sh"

[ $# -lt 1 ] && { echo "用法: $0 <package> [package2 ...]"; exit 1; }

for input in "$@"; do
	short=$(dl_resolve_short_name "$input")
	link="$PI_EXT_DIR/pi-$short"

	# 1. rm symlink
	if [ -L "$link" ]; then
		rm "$link"
		green "✓ unlink: ${short}（rm ${link}）"
	else
		echo "  · ${short} 未 pi-link（${link} 不是 symlink），跳过"
	fi

	# 2. 恢复 pi-link 时备份的 npm 条目
	restored=$(dl_restore_backup "$short")
	if [ "$restored" != "0" ]; then
		green "  ✓ 已恢复 ${restored} 条 npm packages 条目（settings.json）"
	fi
done

echo ""
green "✓ pi 模式 unlink 完成"
echo "  生效：新建 pi session（当前 session 仍用已加载的本地版）"
echo "  npm 条目已从备份还原（如备份存在）；纯本地操作，无需联网"
