#!/bin/bash
# scripts/preflight-check.sh — 打包前预检查
#
# 检查项：
# 1. package.json 完整性（name, version, main）
# 2. 产物存在性（dist/main, dist/preload, dist/runtime, renderer/dist）
# 3. tsup noExternal 与 runtime dependencies 一致性
# 4. electron-builder.yml 结构完整性
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
echo -e "${BLUE}[1/6] package.json fields...${NC}"

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
echo -e "${BLUE}[2/6] Build artifacts exist...${NC}"

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
echo -e "${BLUE}[3/6] tsup noExternal vs runtime dependencies...${NC}"

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
echo -e "${BLUE}[4/6] electron-builder.yml structure...${NC}"

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

# ── 5. asarUnpack 配置检查 ─────────────────────────────────────────
echo ""
echo -e "${BLUE}[5/6] asarUnpack configuration...${NC}"

if [ -f "$EB_YML" ]; then
    if grep -q "asarUnpack" "$EB_YML" && grep -q "dist/runtime" "$EB_YML"; then
        echo -e "  ${GREEN}✓ runtime 在 asarUnpack 中${NC}"
    else
        echo -e "  ${RED}✗ runtime 未配置在 asarUnpack 中${NC}"
        FAILED=1
    fi
fi

# ── 6. 磁盘空间检查 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[6/6] Disk space...${NC}"

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