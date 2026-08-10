#!/usr/bin/env bash
# pi-link.sh — pi 模式：symlink 本地源码到 ~/.pi/agent/extensions/（原版 pi 生效）
#
# 做两件事：
#   1. ln -sfn <本地源码> ~/.pi/agent/extensions/pi-<short>（globalExtDir，loader 第2步扫描）
#   2. 清 settings.json packages 里该 extension 的残留条目（避免 globalExtDir + configuredPaths 两源冲突）
#
# 为何 symlink 而非 pi install path：symlink 在 globalExtDir（loader 扫描早于 configuredPaths），
# pi list 不显示（pi list 只列 packages），但 loader 会发现并加载。pi-statusline 即此模式。
#
# 用法: ./pi-link.sh <package> [package2 ...]
#   <package> = 短名 (subagent-workflow) / pi-前缀 / @zhushanwen/pi-全名
#
# 生效：新建 pi session（当前 session 已加载旧版）。恢复：./pi-unlink.sh <package>
set -euo pipefail

SCOPE="@zhushanwen"
PI_EXT_DIR="$HOME/.pi/agent/extensions"
SETTINGS="$HOME/.pi/agent/settings.json"
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
mkdir -p "$PI_EXT_DIR"

for input in "$@"; do
	short=$(resolve_short_name "$input")
	ext_dir=$(find_extension_dir "$short") || { red "✗ 找不到 extension 目录: extensions/${short}"; continue; }
	link_name="$PI_EXT_DIR/pi-$short"

	# 1. symlink 本地源码到 globalExtDir
	if ln -sfn "$ext_dir" "$link_name" 2>/dev/null; then
		green "✓ symlink: ${short} → ${link_name}"
	else
		red "✗ symlink 失败: ${link_name}"; continue
	fi

	# 2. 清 settings.json packages 里该 extension 的残留条目（npm: 源 + 旧 configuredPaths 本地路径）
	#    避免 globalExtDir + configuredPaths 两源并存冲突
	if [ -f "$SETTINGS" ]; then
		cleaned=$(SHORT="$short" SCOPE="$SCOPE" SETTINGS="$SETTINGS" node -e '
			const fs = require("fs");
			const s = JSON.parse(fs.readFileSync(process.env.SETTINGS, "utf8"));
			const short = process.env.SHORT, scope = process.env.SCOPE;
			const before = (s.packages || []).length;
			s.packages = (s.packages || []).filter(x =>
				x !== `npm:${scope}/pi-${short}`
				&& !x.includes(`/extensions/${short}`)
				&& !new RegExp(`pi-${short}$`).test(x)
			);
			const removed = before - (s.packages || []).length;
			if (removed > 0) fs.writeFileSync(process.env.SETTINGS, JSON.stringify(s, null, 2));
			process.stdout.write(String(removed));
		' 2>/dev/null || echo "0")
		[ "$cleaned" != "0" ] && echo "  · 清 packages 残留 ${cleaned} 条（避免两源冲突）"
	fi
done

echo ""
green "✓ pi 模式 symlink 完成"
echo "  生效：新建 pi session（当前 session 已加载旧版）"
echo "  注：pi list 只列 packages，不显示 globalExtDir symlink——loader 仍会加载（pi-statusline 同模式）"
echo "  验证：新 session 派 subagent 测行为；恢复：./pi-unlink.sh $*"
