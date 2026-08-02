#!/usr/bin/env bash
# prepare-builtin-extensions.sh — 准备 builtin pi extensions 打包产物。
#
# 9 个 builtin extension 包（原 mandatory）连带真实运行时依赖拷贝到
# apps/electron/resources/extensions/@zhushanwen/<pkg>/，
# 再由 electron-builder extraResources 拷进 Resources/extensions/。
#
# 方案：直接从项目 hoisted node_modules 拷贝源码 + 精选真实 deps。
# 不用 pnpm deploy（isolated 模式下 --legacy 会装整个 monorepo 依赖树），
# 不用 npm install（会把 peerDeps 的传递闭包全拖进来）。
#
# peerDeps（@earendil-works/pi-*、typebox）由 pi 进程运行时提供，不拷贝。
# workspace 互引（pi-subagent-workflow 等）是纯契约 peerDep，无运行时 import，不拷贝。
#
# builtin 包清单 SSOT：packages/shared/src/mandatory-extensions.json
# 体积：permission 24M（tree-sitter-bash），structured-output 3M（ajv+传递），
# 其余 <200K，合计约 28M。
#
# Usage: ./scripts/prepare-builtin-extensions.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SRC_NODE_MODULES="$REPO_ROOT/node_modules"
OUTPUT_DIR="apps/electron/resources/extensions"

# ── builtin 包源码目录名（extensions/ 下的目录名）──
BUILTIN_PACKAGES=(
  "ask-user"
  "goal"
  "todo"
  "pending-notifications"
  "subagent-workflow"
  "structured-output"
  "permission"
  "scheduler"
  "rename-session"
)

# ── 每个包的真实运行时 deps（不含 peerDeps，不含 devDeps）──
# 格式："pkg_dir:dep1 dep2 ..."
# 这些 deps 从项目 node_modules 拷贝（含其传递依赖，扁平 hoisted 布局）
declare -A PKG_DEPS
PKG_DEPS["ask-user"]="@xyz-agent/extension-protocol"
PKG_DEPS["goal"]="@xyz-agent/extension-protocol"
PKG_DEPS["todo"]="@xyz-agent/extension-protocol"
PKG_DEPS["pending-notifications"]=""
PKG_DEPS["subagent-workflow"]="@xyz-agent/extension-protocol"
PKG_DEPS["structured-output"]="ajv fast-deep-equal fast-uri json-schema-traverse require-from-string"
PKG_DEPS["permission"]="tree-sitter-bash web-tree-sitter node-addon-api node-gyp-build"
PKG_DEPS["scheduler"]="croner"
PKG_DEPS["rename-session"]=""

echo "=== prepare-builtin-extensions ==="
echo "Output: ${OUTPUT_DIR}/"

# 清理旧产物
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/@zhushanwen"

# 拷贝单个 dep（含 @scope/ 前缀处理）
copy_dep() {
  local dep="$1"
  local dest_node_modules="$2"
  local src="$SRC_NODE_MODULES/$dep"

  if [[ ! -e "$src" ]]; then
    echo "    WARN: $dep not found in node_modules, skipping" >&2
    return 0
  fi

  # 处理 @scope/name 结构
  if [[ "$dep" == @* ]]; then
    mkdir -p "$dest_node_modules/@$(echo "$dep" | cut -d/ -f1 | tr -d @)"
  fi

  # cp -RL dereference symlink（isolated 模式下 node_modules 是 symlink → .pnpm/）
  cp -RL "$src" "$dest_node_modules/$dep" 2>/dev/null || true
}

# 逐包处理
FAILED=0
for pkg_dir in "${BUILTIN_PACKAGES[@]}"; do
  pkg_name="@zhushanwen/pi-${pkg_dir}"
  src_pkg="$REPO_ROOT/extensions/$pkg_dir"
  dest_pkg="$OUTPUT_DIR/@zhushanwen/pi-${pkg_dir}"

  if [[ ! -d "$src_pkg" ]]; then
    echo "  SKIP: extensions/$pkg_dir not found" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  echo "  packaging ${pkg_name}..."

  # 1. 拷贝源码（不含 node_modules / __tests__ / 临时文件）
  rsync -a \
    --exclude node_modules \
    --exclude __tests__ \
    --exclude '*.test.ts' \
    --exclude '.gitignore' \
    --exclude 'PLAN.md' \
    "$src_pkg/" "$dest_pkg/"

  # 2. 拷贝真实运行时 deps
  deps="${PKG_DEPS[$pkg_dir]:-}"
  if [[ -n "$deps" ]]; then
    mkdir -p "$dest_pkg/node_modules"
    for dep in $deps; do
      copy_dep "$dep" "$dest_pkg/node_modules"
    done
  fi
done

# 汇总体积
echo ""
echo "=== Packaged packages ==="
TOTAL_KB=0
for pkg_dir in "${BUILTIN_PACKAGES[@]}"; do
  dest_pkg="$OUTPUT_DIR/@zhushanwen/pi-${pkg_dir}"
  if [[ -d "$dest_pkg" ]]; then
    size_kb=$(du -sk "$dest_pkg" 2>/dev/null | awk '{print $1}')
    size_mb=$(echo "scale=1; ${size_kb} / 1024" | bc)
    echo "  @zhushanwen/pi-${pkg_dir}: ${size_mb}M"
    TOTAL_KB=$((TOTAL_KB + size_kb))
  fi
done
total_mb=$(echo "scale=1; ${TOTAL_KB} / 1024" | bc)
echo "  ────────────"
echo "  Total: ${total_mb}M"

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "ERROR: ${FAILED} package(s) failed" >&2
  exit 1
fi

echo ""
echo "=== Done ==="
