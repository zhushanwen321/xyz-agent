#!/usr/bin/env bash
# pi-link.sh — pi 模式：symlink 本地源码到 ~/.pi/agent/extensions/（原版 pi 生效）
#
# 做三件事（映射查 dev-link-lib.sh，SSOT = extensions/<short>/package.json）：
#   1. ln -sfn <源码目录> ~/.pi/agent/extensions/pi-<short>（globalExtDir，loader 第2步扫描）
#   2. 清 settings.json packages 里该 extension 的残留条目（npm: 源 + 旧本地路径），
#      删除的条目先备份到 ~/.pi/agent/.pi-link-backup.json —— unlink 时自动恢复（状态守恒）
#   3. 库包检查（package.json 无 pi.extensions 字段 → 跳过，如 quota-providers）
#
# 为何 symlink 而非 pi install path：symlink 在 globalExtDir（loader 扫描早于 configuredPaths），
# pi list 不显示（pi list 只列 packages），但 loader 会发现并加载。pi-statusline 即此模式。
# loader 不读目录名——包身份来自目录内 package.json 的 pi.extensions 字段（pi 0.82.1 loader.js）。
#
# 用法: ./pi-link.sh <package> [package2 ...]
#   <package> = 短名 (subagent-workflow) / pi-前缀 / @zhushanwen/pi-全名
#
# 生效：新建 pi session（当前 session 已加载旧版）。恢复：./pi-unlink.sh <package>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dev-link-lib.sh
source "$SCRIPT_DIR/dev-link-lib.sh"

[ $# -lt 1 ] && { echo "用法: $0 <package> [package2 ...]"; exit 1; }
mkdir -p "$PI_EXT_DIR"

for input in "$@"; do
	short=$(dl_resolve_short_name "$input")

	# 查映射（源码目录 + npm 包名 + 是否真 extension，均来自 package.json）
	if ! dl_lookup "$short"; then
		red "✗ 找不到 extension: ${short}（extensions/${short} 或 extensions/shared/${short} 需有 package.json）"
		continue
	fi
	if [ "$DL_IS_EXT" != "yes" ]; then
		yellow "↷ 跳过 ${short}：是库包（shared lib，${DL_NPM_NAME}），不是 pi extension"
		continue
	fi

	# 1. symlink 本地源码到 globalExtDir
	link_name="$PI_EXT_DIR/pi-$short"
	if ln -sfn "$DL_SRC_DIR" "$link_name" 2>/dev/null; then
		green "✓ symlink: ${short} → ${link_name}"
	else
		red "✗ symlink 失败: ${link_name}"
		continue
	fi

	# 2. 清 settings.json packages 残留（npm: 源精确匹配 + 旧本地路径），删除条目先备份
	cleaned=$(dl_backup_and_clean "$short" "$DL_NPM_NAME")
	if [ "$cleaned" != "0" ]; then
		echo "  · 备份并清 packages 残留 ${cleaned} 条（unlink 时自动恢复 npm 条目）"
	fi
done

echo ""
green "✓ pi 模式 symlink 完成"
echo "  生效：新建 pi session（当前 session 已加载旧版）"
echo "  注：pi list 只列 packages，不显示 globalExtDir symlink——loader 仍会加载（pi-statusline 同模式）"
echo "  验证：新 session 派 subagent 测行为；恢复：./pi-unlink.sh $*（自动还原 npm 条目）"
