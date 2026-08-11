#!/usr/bin/env bash
# link-local.sh — 添加 extension 到 XYZ_EXTENSION_PATHS（本地源码，live edit）
# 用法: ./link-local.sh <package> [package2 ...]
#   <package> = 短名 (model-switch) / pi-前缀 (pi-model-switch) / npm全名 (@zhushanwen/pi-model-switch)
#
# 幂等安全：重复添加不会产生重复条目，已是目标状态时直接跳过。
# 写入项目根目录的 .env.dev-extensions 文件（已 gitignore）。
set -euo pipefail

SCOPE="@zhushanwen"
ENV_FILE_NAME=".env.dev-extensions"
ENV_VAR="XYZ_EXTENSION_PATHS"

# ── 颜色输出 ────────────────────────────────────────────
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# ── 定位项目根目录 ──────────────────────────────────────
# 用 git rev-parse 定位 worktree 根（多 worktree 友好）
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { red "✗ 不在 git 仓库中"; exit 2; })"
EXTENSIONS_BASE="$GIT_ROOT/extensions"
ENV_FILE="$GIT_ROOT/$ENV_FILE_NAME"

# ── 包名解析：支持三种格式 → 统一为短名 ─────────────────
resolve_short_name() {
	local input="$1"
	if [[ "$input" == "$SCOPE/"* ]]; then
		# @zhushanwen/pi-model-switch → model-switch
		# @zhushanwen/pi-quota-providers → 特殊：在 shared/ 下
		local stripped="${input#$SCOPE/pi-}"
		echo "$stripped"
	elif [[ "$input" == pi-* ]]; then
		# pi-model-switch → model-switch
		echo "${input#pi-}"
	else
		# model-switch → model-switch
		echo "$input"
	fi
}

# ── 定位 extension 源码目录 ─────────────────────────────
# quota-providers 在 extensions/shared/ 下，其余在 extensions/ 下
find_extension_dir() {
	local short="$1"
	local candidates=(
		"$EXTENSIONS_BASE/$short"
		"$EXTENSIONS_BASE/shared/$short"
	)
	for dir in "${candidates[@]}"; do
		if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
			echo "$dir"
			return 0
		fi
	done
	return 1
}

# ── 检查是否是真正的 pi extension（非库包）──────────────
# 通过 PKG_DIR 环境变量传参（避免 set -u 下 $1 unbound）
is_pi_extension() {
	# 库包（如 quota-providers）不是 pi extension，不进 XYZ_EXTENSION_PATHS
	# 判定：package.json 有 pi.extensions 字段
	node -e "
		const pkg = require(process.env.PKG_DIR + '/package.json');
		process.exit(pkg.pi && pkg.pi.extensions ? 0 : 1);
	" 2>/dev/null
}

# ── 检查是否 mandatory 包（SSOT: packages/shared/src/mandatory-extensions.json）──
# mandatory 包删 npm 安装安全：unlink 后 xyz-agent 重启时 ensureMandatoryExtensions 自动重装。
# 非 mandatory 包不删：link-npm.sh unlink 不重装，删除会导致扩展在 dev 模式彻底消失。
is_mandatory() {
	local short="$1"
	MANDATORY_JSON="$GIT_ROOT/packages/shared/src/mandatory-extensions.json" SHORT="$short" node -e "
		const list = require(process.env.MANDATORY_JSON);
		process.exit(list.some(p => p.name === '@zhushanwen/pi-' + process.env.SHORT) ? 0 : 1);
	" 2>/dev/null
}

# ── 主逻辑 ──────────────────────────────────────────────
main() {
	if [ $# -lt 1 ]; then
		echo "用法: $0 <package> [package2 ...]"
		echo "  <package> = 短名 (model-switch) / pi-前缀 (pi-model-switch) / npm全名 (@zhushanwen/pi-model-switch)"
		echo "  可一次 link 多个: $0 goal todo ask-user"
		exit 1
	fi

	# 创建 .env.dev-extensions（如不存在）
	if [ ! -f "$ENV_FILE" ]; then
		echo "# 由 dev-link skill 生成，管理 XYZ_EXTENSION_PATHS（本地 extension 源码路径）" > "$ENV_FILE"
		echo "# 不进 git（已覆盖在 .gitignore 的 .env.* 规则下）" >> "$ENV_FILE"
		echo "# 用法: set -a && source $ENV_FILE_NAME && set +a && pnpm dev" >> "$ENV_FILE"
		green "✓ 创建 $ENV_FILE_NAME"
	fi

	local added=0
	local skipped=0

	for input in "$@"; do
		local short
		short=$(resolve_short_name "$input")

		local ext_dir
		if ! ext_dir=$(find_extension_dir "$short"); then
			red "✗ 找不到 extension 目录: extensions/${short}（或 extensions/shared/${short}）"
			echo "   确保在 xyz-agent 的正确 worktree 根目录执行"
			((skipped++)) || true
			continue
		fi

		# 检查是否是 pi extension（跳过库包）
		if ! PKG_DIR="$ext_dir" is_pi_extension; then
			yellow "↷ 跳过 ${short}：是库包（shared lib），不是 pi extension，不进 ${ENV_VAR}"
			((skipped++)) || true
			continue
		fi

		# 检查是否已在 ENV_FILE 中
		if grep -qF "$ext_dir" "$ENV_FILE" 2>/dev/null; then
			echo "  · ${short} 已 link，跳过"
			((skipped++)) || true
			continue
		fi

		# 检查并清理已有 npm 安装（dev 数据目录）——仅限 mandatory 包。
		# 注：user 源（XYZ_EXTENSION_PATHS，优先级 2）高于 settings 源（npm 安装，优先级 4），
		#     本地源码本就优先，并存无歧义。删除仅对 mandatory 有必要（boot 重装前的显式归位，
		#     删后由 ensureMandatoryExtensions 重启自动重装兜底）。非 mandatory 包删除会破坏
		#     link-npm.sh 的「回归 npm 版本」语义——unlink 不重装，npm 安装被删后扩展彻底消失。
		local data_dir="${XYZ_AGENT_DATA_DIR:-$HOME/.xyz-agent-dev}"
		local npm_pkg_dir="$data_dir/npm/node_modules/$SCOPE/pi-$short"
		if [ -d "$npm_pkg_dir" ] && is_mandatory "$short"; then
			rm -rf "$npm_pkg_dir"
			echo "  · 清理已有 npm 安装（mandatory）：$npm_pkg_dir"
		fi

		# 追加到 XYZ_EXTENSION_PATHS
		# 读取当前值（从 ENV_FILE 解析，格式：XYZ_EXTENSION_PATHS=path1:path2）
		local current=""
		if grep -q "^${ENV_VAR}=" "$ENV_FILE" 2>/dev/null; then
			current=$(grep "^${ENV_VAR}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
		fi

		if [ -z "$current" ]; then
			# 新行
			echo "${ENV_VAR}=${ext_dir}" >> "$ENV_FILE"
		else
			# 追加到现有值（用 node 重写整个 ENV_FILE，避免 sed 转义问题）
			ENV_FILE="$ENV_FILE" ENV_VAR="$ENV_VAR" NEW_PATH="$ext_dir" node -e "
				const fs = require('fs');
				const lines = fs.readFileSync(process.env.ENV_FILE, 'utf-8').split('\n');
				const updated = lines.map(line => {
					if (line.startsWith(process.env.ENV_VAR + '=')) {
						return line + ':' + process.env.NEW_PATH;
					}
					return line;
				});
				fs.writeFileSync(process.env.ENV_FILE, updated.join('\n'));
			"
		fi

		green "✓ link: ${short} → ${ext_dir}"
		((added++)) || true
	done

	echo ""
	if [ "$added" -gt 0 ]; then
		green "✓ 完成: 新增 $added 个 link，跳过 $skipped 个"
		echo ""
		echo "  启动带 link 的 dev（source 环境变量后启动）:"
		echo "    set -a && source $ENV_FILE_NAME && set +a && pnpm dev"
		echo ""
		echo "  改源码后在 xyz-agent 中新建 session 即生效（无需重启）"
	else
		echo "  无新增 link（$skipped 个跳过）"
	fi
}

main "$@"
