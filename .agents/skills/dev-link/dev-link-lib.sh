#!/usr/bin/env bash
# dev-link-lib.sh — dev-link skill 的共享库（pi 模式 + xyz-agent 模式脚本统一 source）
#
# 核心设计：短名 → 事实的映射从本项目 extensions/ 目录扫描构建（SSOT = 各包的 package.json）：
#
#   extensions/<short>/package.json
#     ├─ name           → npm 包名（如 @zhushanwen/pi-subagent-workflow）
#     ├─ pi.extensions  → 是否真 pi extension（库包如 quota-providers 没有该字段）
#     └─ 目录本身        → 源码目录（symlink target / XYZ_EXTENSION_PATHS 条目）
#
# 脚本不再按命名约定推导 npm 包名（"@zhushanwen/pi-" + short），而是读 package.json 的 name 字段。
# 新增/改名包自动进映射，脚本零改动。
#
# 另提供 settings.json packages 条目的备份/恢复：pi-link 清理 npm 条目时先备份，
# pi-unlink 时恢复 —— 保证 link → unlink 往返后 extension 回到 npm 源（状态守恒）。
#
# 兼容性：macOS 自带 bash 3.2（无关联数组），避免使用 bash 4+ 特性。

SCOPE="@zhushanwen"
PI_EXT_DIR="$HOME/.pi/agent/extensions"
SETTINGS="$HOME/.pi/agent/settings.json"
# 备份文件放 agentDir 下（不在 extensions/ 里，避免被 pi loader 扫描）
DL_BACKUP_FILE="$HOME/.pi/agent/.pi-link-backup.json"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# ── 定位 worktree 根（多 worktree 友好）──────────────────────────────
# 失败不退出（unlink 等场景不依赖 git），由调用方决定是否需要。
dl_git_root() {
	DL_GIT_ROOT="${DL_GIT_ROOT:-}"
	if [ -z "$DL_GIT_ROOT" ]; then
		DL_GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
	fi
	[ -n "$DL_GIT_ROOT" ]
}

# ── 包名解析：三种输入格式 → 短名 ────────────────────────────────────
#   @zhushanwen/pi-subagent-workflow → subagent-workflow
#   pi-subagent-workflow             → subagent-workflow
#   subagent-workflow                → subagent-workflow
dl_resolve_short_name() {
	local input="$1"
	if [[ "$input" == "$SCOPE/"* ]]; then
		echo "${input#$SCOPE/pi-}"
	elif [[ "$input" == pi-* ]]; then
		echo "${input#pi-}"
	else
		echo "$input"
	fi
}

# ── 构建映射：一次 node 扫描 extensions/ + extensions/shared/ ────────
# 输出行格式：short|npm_name|src_dir|is_extension（is_extension = package.json 有 pi.extensions）
dl_build_mapping() {
	dl_git_root || return 1
	local base="$DL_GIT_ROOT/extensions"
	node -e '
		const fs = require("fs"), path = require("path");
		const base = process.argv[1];
		const out = [];
		for (const sub of ["", "shared/"]) {
			const dir = path.join(base, sub);
			if (!fs.existsSync(dir)) continue;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const d = path.join(dir, entry.name);
				const pkgPath = path.join(d, "package.json");
				if (!fs.existsSync(pkgPath)) continue;
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
				const isExt = !!(pkg.pi && pkg.pi.extensions);
				out.push([entry.name, pkg.name || "", d, isExt ? "yes" : "no"].join("|"));
			}
		}
		process.stdout.write(out.join("\n"));
	' "$base"
}

# ── 查表：short → 事实（结果存 DL_* 全局变量）────────────────────────
# 映射懒构建并缓存到 DL_MAPPING（避免多次扫描）。
dl_lookup() {
	local short="$1"
	if [ -z "${DL_MAPPING:-}" ]; then
		DL_MAPPING="$(dl_build_mapping || true)"
	fi
	local line
	line=$(printf '%s\n' "$DL_MAPPING" | grep "^${short}|" | head -1)
	[ -n "$line" ] || return 1
	DL_SHORT="${line%%|*}"
	DL_NPM_NAME="$(echo "$line" | cut -d'|' -f2)"
	DL_SRC_DIR="$(echo "$line" | cut -d'|' -f3)"
	DL_IS_EXT="$(echo "$line" | cut -d'|' -f4)"
	return 0
}

# ── 清理 settings.json packages 残留并备份（pi-link 调用）────────────
# 删除两类条目：
#   1. npm 条目：精确匹配 "npm:<实际 npm 包名>"（读 package.json，不按命名约定拼）
#   2. 旧本地路径残留：非 npm: 开头且 basename 恰好等于短名（兼容历史 pi install path 格式）
# 删除的条目按 short 记入备份文件，供 dl_restore_backup 恢复。
# stdout 输出删除条数。
dl_backup_and_clean() {
	local short="$1" npm_name="$2"
	[ -f "$SETTINGS" ] || { echo "0"; return 0; }
	SHORT="$short" NPM_NAME="$npm_name" SETTINGS="$SETTINGS" BACKUP="$DL_BACKUP_FILE" node -e '
		const fs = require("fs");
		const s = JSON.parse(fs.readFileSync(process.env.SETTINGS, "utf8"));
		const short = process.env.SHORT, npmName = process.env.NPM_NAME;
		const packages = s.packages || [];
		const removed = [];
		const kept = packages.filter(x => {
			const isNpm = x === "npm:" + npmName;
			const isLegacyPath = !x.startsWith("npm:") && x.split("/").pop() === short;
			if (isNpm || isLegacyPath) { removed.push(x); return false; }
			return true;
		});
		if (removed.length > 0) {
			let backup = {};
			if (fs.existsSync(process.env.BACKUP)) {
				backup = JSON.parse(fs.readFileSync(process.env.BACKUP, "utf8"));
			}
			backup[short] = [...new Set([...(backup[short] || []), ...removed])];
			s.packages = kept;
			fs.writeFileSync(process.env.SETTINGS, JSON.stringify(s, null, 2));
			fs.writeFileSync(process.env.BACKUP, JSON.stringify(backup, null, 2));
		}
		process.stdout.write(String(removed.length));
	'
}

# ── 恢复备份的 npm 条目（pi-unlink 调用）─────────────────────────────
# 把该 short 备份的条目写回 settings.json packages（去重），恢复后删除备份记录。
# stdout 输出恢复条数（0 = 无备份/无变化）。
dl_restore_backup() {
	local short="$1"
	[ -f "$DL_BACKUP_FILE" ] || { echo "0"; return 0; }
	SHORT="$short" SETTINGS="$SETTINGS" BACKUP="$DL_BACKUP_FILE" node -e '
		const fs = require("fs");
		const backup = JSON.parse(fs.readFileSync(process.env.BACKUP, "utf8"));
		const short = process.env.SHORT;
		const entries = backup[short];
		if (!entries || entries.length === 0) {
			delete backup[short];
			if (Object.keys(backup).length > 0) {
				fs.writeFileSync(process.env.BACKUP, JSON.stringify(backup, null, 2));
			} else {
				fs.unlinkSync(process.env.BACKUP);
			}
			process.stdout.write("0");
			process.exit(0);
		}
		const s = JSON.parse(fs.readFileSync(process.env.SETTINGS, "utf8"));
		const packages = s.packages || [];
		let added = 0;
		for (const e of entries) {
			if (!packages.includes(e)) { packages.push(e); added++; }
		}
		if (added > 0) {
			s.packages = packages;
			fs.writeFileSync(process.env.SETTINGS, JSON.stringify(s, null, 2));
		}
		delete backup[short];
		if (Object.keys(backup).length > 0) {
			fs.writeFileSync(process.env.BACKUP, JSON.stringify(backup, null, 2));
		} else {
			fs.unlinkSync(process.env.BACKUP);
		}
		process.stdout.write(String(added));
	'
}
