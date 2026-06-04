#!/bin/bash
# scripts/preflight-check.sh — 打包前预检查
#
# 检查项：
# 1. package.json 完整性（name, version, main）
# 2. 产物存在性（dist/main, dist/preload, dist/runtime, renderer/dist）
# 3. tsup noExternal 与 runtime dependencies 一致性
# 4. electron-builder.yml 结构完整性
# 5. asarUnpack 与 files 一致性（防止 files 排除 dist/runtime）
# 6. resources/pi 无指向外部绝对路径的 symlink
# 7. @zhushanwen/pi-* npm packages 存在且入口文件存在
# 8. pi-ext 传递依赖完整性
# 9. 磁盘空间
#
# 用法: npm run preflight 或 CI 中单独调用
# CI 模式: ./scripts/preflight-check.sh --ci（任何失败都非 0）

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CI_MODE=false
if [ "${1:-}" = "--ci" ]; then
    CI_MODE=true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Preflight Checks]${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

ELECTRON_DIR="$PROJECT_ROOT/src-electron"
FAILED=0

# ── 1. package.json 完整性 ─────────────────────────────────────────
echo ""
echo -e "${BLUE}[1/9] package.json fields...${NC}"

# 检查 src-electron/package.json（electron-builder 的工作目录）
ELECTRON_PKG="$ELECTRON_DIR/package.json"
node -e "
const pkg = require('$ELECTRON_PKG');
const required = ['name', 'version', 'main', 'description'];
for (const f of required) {
  if (!pkg[f]) { console.error('Missing required field:', f); process.exit(1); }
}
if (!/^\d+\.\d+\.\d+/.test(pkg.version)) {
  console.error('Invalid semver:', pkg.version); process.exit(1);
}
console.log('  ✓', pkg.name, 'v' + pkg.version);
" || { FAILED=1; echo -e "${RED}[FAIL]${NC}"; }

# ── 2. 产物存在性 ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[2/9] Build artifacts exist...${NC}"

check_file() {
    local path="$1"
    local label="$2"
    if [ -f "$path" ]; then
        echo -e "  ${GREEN}✓${NC} $label"
    else
        echo -e "  ${RED}✗${NC} $label NOT FOUND: $path"
        return 1
    fi
}

check_dir() {
    local path="$1"
    local label="$2"
    if [ -d "$path" ]; then
        echo -e "  ${GREEN}✓${NC} $label"
    else
        echo -e "  ${RED}✗${NC} $label NOT FOUND: $path"
        return 1
    fi
}

(
    check_file "$ELECTRON_DIR/dist/main/main.cjs" "main entry" || true
    check_file "$ELECTRON_DIR/dist/preload/preload.cjs" "preload entry" || true
    check_file "$ELECTRON_DIR/dist/runtime/index.cjs" "runtime bundle" || true
    check_file "$ELECTRON_DIR/renderer/dist/index.html" "renderer index" || true
) || FAILED=1

# ── 3. tsup noExternal 与 runtime dependencies 同步 ─────────────────
echo ""
echo -e "${BLUE}[3/9] tsup noExternal vs runtime dependencies...${NC}"

RUNTIME_PKG="$ELECTRON_DIR/runtime/package.json"
RUNTIME_TSUP="$ELECTRON_DIR/runtime/tsup.config.ts"

if [ -f "$RUNTIME_PKG" ] && [ -f "$RUNTIME_TSUP" ]; then
    DEPS=$(node -e "const p=require('$RUNTIME_PKG');console.log(Object.keys(p.dependencies||{}).join('\n'))")
    NO_EXT=$(node -e "
const fs=require('fs');
const content=fs.readFileSync('$RUNTIME_TSUP','utf-8');
const match=content.match(/noExternal:\\s*\\[([^\\]]+)\\]/);
if(match) console.log(match[1].split(/[,\n]/).map(s=>s.trim().replace(/['\"]/g,'')).filter(Boolean).join('\n'));
else console.log('');
")

    MISSING=""
    for dep in $DEPS; do
        if [ -n "$dep" ] && ! echo "$NO_EXT" | grep -qx "$dep"; then
            MISSING="$MISSING $dep"
        fi
    done

    if [ -n "$MISSING" ]; then
        echo -e "  ${RED}✗ noExternal 缺少依赖:$MISSING${NC}"
        echo -e "  ${YELLOW}FIX: 编辑 $RUNTIME_TSUP，noExternal 追加:$MISSING${NC}"
        FAILED=1
    else
        echo -e "  ${GREEN}✓ noExternal 覆盖所有 runtime dependencies${NC}"
    fi
else
    echo -e "  ${YELLOW}⚠ 跳过（文件不存在）${NC}"
fi

# ── 4. electron-builder.yml 结构 ────────────────────────────────────
echo ""
echo -e "${BLUE}[4/9] electron-builder.yml structure...${NC}"

EB_YML="$ELECTRON_DIR/electron-builder.yml"
if [ -f "$EB_YML" ]; then
    if node -e "const fs=require('fs');require('js-yaml').load(fs.readFileSync('$EB_YML','utf8'));console.log('ok')" 2>/dev/null; then
        echo -e "  ${GREEN}✓ YAML 语法正确${NC}"
    else
        echo -e "  ${YELLOW}⚠ YAML 解析跳过（js-yaml 未安装）${NC}"
    fi

    # 检查关键配置项
    for key in appId productName asar; do
        if grep -q "^$key:" "$EB_YML"; then
            echo -e "  ${GREEN}✓${NC} $key 配置存在"
        else
            echo -e "  ${YELLOW}⚠ $key 缺失${NC}"
        fi
    done
else
    echo -e "  ${RED}✗ electron-builder.yml 不存在${NC}"
    FAILED=1
fi

# ── 5. asarUnpack 与 files 一致性检查 ─────────────────────────────
echo ""
echo -e "${BLUE}[5/9] asarUnpack vs files consistency...${NC}"

if [ -f "$EB_YML" ]; then
    if grep -q "asarUnpack" "$EB_YML" && grep -q "dist/runtime" "$EB_YML"; then
        echo -e "  ${GREEN}✓ runtime 在 asarUnpack 中${NC}"
    else
        echo -e "  ${RED}✗ runtime 未配置在 asarUnpack 中${NC}"
        FAILED=1
    fi

    # 致命：files 中排除 dist/runtime 会导致 asarUnpack 无文件可解压
    # 排除 YAML 注释行（以 # 开头）
    if grep -v '^[[:space:]]*#' "$EB_YML" | grep -qE '!dist/runtime'; then
        echo -e "  ${RED}✗ FATAL: files 规则排除了 dist/runtime，asarUnpack 将失效${NC}"
        echo -e "  ${YELLOW}  FIX: 删除 files 中的 '!dist/runtime/**/*'，让 asarUnpack 处理${NC}"
        FAILED=1
    else
        echo -e "  ${GREEN}✓ files 未排除 dist/runtime${NC}"
    fi

    # 致命：files 必须显式包含 dist/runtime，否则 asarUnpack 无文件可 unpack
    # electron-builder 的 files 和 asarUnpack 是 AND 关系
    if grep -v '^[[:space:]]*#' "$EB_YML" | grep -qE '^\s*-\s+dist/runtime/'; then
        echo -e "  ${GREEN}✓ files 显式包含 dist/runtime${NC}"
    else
        echo -e "  ${RED}✗ FATAL: files 未显式包含 dist/runtime，asarUnpack 将静默失败${NC}"
        echo -e "  ${YELLOW}  FIX: 在 files 中添加 '- dist/runtime/**/*'${NC}"
        FAILED=1
    fi
fi

# ── 6. resources/pi symlink 检查 ───────────────────────────────────
echo ""
echo -e "${BLUE}[6/9] resources/pi symlink check...${NC}"

PI_RES_DIR="$ELECTRON_DIR/resources/pi"
SYMLINK_FOUND=false
if [ -d "$PI_RES_DIR" ]; then
    while IFS= read -r link; do
        target=$(readlink "$link")
        echo -e "  ${RED}✗${NC} 发现 symlink: $(basename "$link") -> $target"
        SYMLINK_FOUND=true
    done < <(find "$PI_RES_DIR" -maxdepth 1 -type l 2>/dev/null)
fi

if [ "$SYMLINK_FOUND" = true ]; then
    echo -e "  ${RED}✗ resources/pi 中存在 symlink，打包后目标路径在用户机器上不存在${NC}"
    echo -e "  ${YELLOW}  FIX: 用真实目录替换 symlink：cd $PI_RES_DIR && for l in \$(find . -maxdepth 1 -type l); do t=\$(readlink \$l); rm \$l; cp -R \"\$t\" \$(basename \$l); done${NC}"
    FAILED=1
else
    echo -e "  ${GREEN}✓ resources/pi 无 symlink${NC}"
fi

# ── 7. @zhushanwen/pi-* npm packages check ───────────────────────
echo ""
echo -e "${BLUE}[7/9] @zhushanwen/pi-* npm packages...${NC}"

# builtin pi extension 在根 node_modules（通过 extraResources 打包），不在 src-electron/node_modules
PI_EXT_SEARCH_DIRS=("$PROJECT_ROOT/node_modules/@zhushanwen" "$ELECTRON_DIR/node_modules/@zhushanwen")

found=0
for search_dir in "${PI_EXT_SEARCH_DIRS[@]}"; do
  for pkg in "$search_dir"/pi-*/package.json; do
    if [ -f "$pkg" ]; then
      pkg_dir=$(dirname "$pkg")
      pkg_name=$(basename "$pkg_dir")
      # 验证 main 入口文件存在（FR-7.4a）
      main_entry=$(node -e "const p=require('$pkg');console.log(p.main||'index.js')" 2>/dev/null || echo "index.js")
      if [ ! -f "$pkg_dir/$main_entry" ] && [ ! -f "$pkg_dir/index.ts" ]; then
        echo -e "  ${YELLOW}⚠ $pkg_name missing entry ($main_entry)${NC}"
      fi
      found=$((found + 1))
    fi
  done
done
if [ "$found" -lt 1 ]; then
  echo -e "  ${RED}✗ No @zhushanwen/pi-* packages found in node_modules${NC}"
  FAILED=1
else
  echo -e "  ${GREEN}✓ Found $found pi-ext packages${NC}"
fi

# ── 8. pi-ext transitive dependencies check ───────────────────────
echo ""
echo -e "${BLUE}[8/9] pi-ext transitive dependencies...${NC}"

missing_deps=0
for search_dir in "${PI_EXT_SEARCH_DIRS[@]}"; do
  for pkg in "$search_dir"/pi-*/package.json; do
    [ -f "$pkg" ] || continue
    pkg_name=$(basename "$(dirname "$pkg")")
    deps=$(node -e "
      const p = require('$pkg');
      const all = Object.keys(p.dependencies || {});
      const external = all.filter(d => !d.startsWith('@zhushanwen/'));
      console.log(external.join('\n'));
    " 2>/dev/null || true)
    for dep in $deps; do
      # 检查两个位置
      if [ ! -d "$PROJECT_ROOT/node_modules/$dep" ] && [ ! -d "$ELECTRON_DIR/node_modules/$dep" ]; then
        echo -e "  ${RED}✗ Missing transitive dep: $dep (required by $pkg_name)${NC}"
        missing_deps=$((missing_deps + 1))
      fi
    done
  done
done
if [ "$missing_deps" -gt 0 ]; then
  echo -e "  ${RED}✗ $missing_deps missing transitive dependencies${NC}"
  FAILED=1
else
  echo -e "  ${GREEN}✓ All pi-ext transitive dependencies present${NC}"
fi

# ── 9. 磁盘空间检查 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[9/9] Disk space...${NC}"

AVAILABLE_GB=$(df -g . | tail -1 | awk '{print $4}')
if [ "$AVAILABLE_GB" -lt 3 ]; then
    echo -e "  ${RED}✗ 磁盘空间不足: ${AVAILABLE_GB}GB（建议 ≥3GB）${NC}"
    FAILED=1
else
    echo -e "  ${GREEN}✓ ${AVAILABLE_GB}GB 可用${NC}"
fi

# ── 结果 ───────────────────────────────────────────────────────────
echo ""
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}[OK] Preflight 检查全部通过${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 0
else
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}[FAIL] Preflight 检查有失败项${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
fi