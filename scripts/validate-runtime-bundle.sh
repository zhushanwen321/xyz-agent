#!/bin/bash
# validate-runtime-bundle.sh — 验证 runtime 打包产物可正常启动
#
# 检查项：
# 1. tsup build 产物存在
# 2. 产物包含所有 runtime dependencies（semver, fast-glob, ws）
# 3. CJS 产物不依赖 import.meta（兼容 Electron 子进程 ELECTRON_RUN_AS_NODE）
# 4. 产物能正常启动（health check）
#
# 用法: ./scripts/validate-runtime-bundle.sh [--ci]
#   --ci    CI 模式：严格模式，任何失败都会退出码非 0

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CI_MODE=false
if [ "$1" = "--ci" ]; then
    CI_MODE=true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Runtime Bundle 验证]${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

RUNTIME_DIR="$PROJECT_ROOT/src-electron/runtime"
BUNDLE_PATH="$PROJECT_ROOT/src-electron/dist/runtime/index.cjs"

# ── 1. Build 产物存在 ──────────────────────────────────────────────
echo ""
echo -e "${BLUE}[1/5] 检查 build 产物...${NC}"

if [ ! -f "$BUNDLE_PATH" ]; then
    echo -e "${YELLOW}[WARN] 产物不存在，先运行 build...${NC}"
    cd "$RUNTIME_DIR" && npm run build
fi

if [ ! -f "$BUNDLE_PATH" ]; then
    echo -e "${RED}[ERROR] 产物不存在: $BUNDLE_PATH${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] 产物存在: $BUNDLE_PATH${NC}"

# ── 2. 依赖打包检查 ─────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[2/5] 检查依赖是否打包（noExternal）...${NC}"

# 从 package.json 读取 dependencies
RUNTIME_PKG="$RUNTIME_DIR/package.json"
DEPS=$(node -e "const p=require('$RUNTIME_PKG');console.log(Object.keys(p.dependencies||{}).join('\n'))")

# 从 tsup.config.ts 读取 noExternal 配置
TSUP_CONFIG="$RUNTIME_DIR/tsup.config.ts"
NO_EXTERNAL=$(node -e "
const fs=require('fs');
const content=fs.readFileSync('$TSUP_CONFIG','utf-8');
const match=content.match(/noExternal:\\s*\\[([^\\]]+)\\]/);
if(match) console.log(match[1].split(/[,\n]/).map(s=>s.trim().replace(/['\"]/g,'')).filter(Boolean).join('\n'));
else console.log('');
")

MISSING=""
for dep in $DEPS; do
    if [ -n "$dep" ] && ! echo "$NO_EXTERNAL" | grep -qx "$dep"; then
        MISSING="$MISSING $dep"
    fi
done

if [ -n "$MISSING" ]; then
    echo -e "${RED}[ERROR] 以下 runtime 依赖未在 tsup noExternal 中：$MISSING${NC}"
    echo -e "${YELLOW}[FIX] 编辑 $RUNTIME_DIR/tsup.config.ts，noExternal 追加:$MISSING${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] 所有 runtime dependencies 已打包 (noExternal: $NO_EXTERNAL)${NC}"

# ── 3. CJS 兼容性检查 ───────────────────────────────────────────────
echo ""
echo -e "${BLUE}[3/5] 检查 CJS 兼容性（禁止 import.meta / fileURLToPath）...${NC}"

# 允许的 import.meta 用法：有 __dirname 兼容层或 getAppVersion/getPluginHostDir 的注释说明
IMPORTS_META=$(grep -rn "import\.meta" "$RUNTIME_DIR/src" --include="*.ts" 2>/dev/null | grep -v "^[^:]*:[0-9]*:.*//.*getPluginHostDir\|^[^:]*:[0-9]*:.*//.*getAppVersion\|^[^:]*:[0-9]*:\s*//.*CJS bundle\|^[^:]*:[0-9]*:\s*/\*\|^[^:]*:[0-9]*:\s*\*" || true)

if [ -n "$IMPORTS_META" ]; then
    echo -e "${RED}[ERROR] runtime 源码使用了 import.meta，CJS bundle 会变成 undefined：${NC}"
    echo "$IMPORTS_META" | sed 's/^/  /'
    echo -e "${YELLOW}[FIX] 使用 __dirname 或 process.cwd() 代替 import.meta.url${NC}"
    exit 1
fi

FILE_URL_USAGE=$(grep -rn "fileURLToPath" "$RUNTIME_DIR/src" --include="*.ts" 2>/dev/null || true)
if [ -n "$FILE_URL_USAGE" ]; then
    echo -e "${RED}[ERROR] runtime 源码使用了 fileURLToPath（CJS 中需要 import.meta.url）：${NC}"
    echo "$FILE_URL_USAGE" | sed 's/^/  /'
    echo -e "${YELLOW}[FIX] 使用 __dirname 兼容层或 process.cwd() 代替${NC}"
    exit 1
fi

echo -e "${GREEN}[OK] 无 import.meta / fileURLToPath 引用${NC}"

# ── 4. 产物自包含验证 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[4/5] 检查产物是否包含所有依赖...${NC}"

for dep in $DEPS; do
    if [ -n "$dep" ]; then
        if ! grep -q "$dep" "$BUNDLE_PATH"; then
            echo -e "${RED}[ERROR] 产物缺少依赖 $dep（noExternal 可能遗漏）${NC}"
            exit 1
        fi
    fi
done
echo -e "${GREEN}[OK] 产物包含所有依赖${NC}"

# ── 5. 运行时健康检查 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[5/5] 运行时健康检查...${NC}"

# 随机选一个可用端口
PORT=3250
for p in $(seq 3250 3260); do
    if ! lsof -n -P -i :$p 2>/dev/null | grep LISTEN > /dev/null; then
        PORT=$p
        break
    fi
done

# 启动 runtime，等待 ready，发送 health check，清理
RUNTIME_PID=""
cleanup() {
    if [ -n "$RUNTIME_PID" ] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
        kill "$RUNTIME_PID" 2>/dev/null || true
        wait "$RUNTIME_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

node "$BUNDLE_PATH" --port=$PORT > /tmp/runtime-validate.log 2>&1 &
RUNTIME_PID=$!

# 等待 runtime ready（最多 15s）
READY=false
for i in $(seq 1 30); do
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q "ok"; then
        READY=true
        break
    fi
    sleep 0.5
done

if [ "$READY" = true ]; then
    echo -e "${GREEN}[OK] Runtime 启动成功 (port $PORT)${NC}"
else
    echo -e "${RED}[ERROR] Runtime 启动超时或失败${NC}"
    echo -e "${YELLOW}日志:${NC}"
    cat /tmp/runtime-validate.log | tail -20
    exit 1
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}[OK] Runtime Bundle 验证全部通过${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"