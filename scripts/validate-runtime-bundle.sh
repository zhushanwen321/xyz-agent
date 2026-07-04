#!/bin/bash
# validate-runtime-bundle.sh — 验证 runtime 打包产物可正常启动
#
# 检查项：
# 1. tsup build 产物存在（index.cjs + plugin-bootstrap.cjs）
# 2. 产物包含所有 runtime dependencies（semver, fast-glob, ws）
# 3. CJS 产物不依赖 import.meta（兼容 Electron 子进程 ELECTRON_RUN_AS_NODE）
# 4. 产物自包含验证（所有依赖已打入 bundle）
# 5. plugin-bootstrap.cjs 可独立解析（Worker Thread 入口）
# 6. 产物能正常启动（health check）
#
# 用法: ./scripts/validate-runtime-bundle.sh [--ci]
#   --ci    CI 模式：严格模式，任何失败都会退出码非 0

set -e

# 检查失败原则提示（合并进 cleanup EXIT trap，避免覆盖）
__check_principle() {
  [ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。" >&2
  return 0
}

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

RUNTIME_DIR="$PROJECT_ROOT/packages/runtime"
DIST_RUNTIME="$PROJECT_ROOT/apps/electron/dist/runtime"
BUNDLE_PATH="$DIST_RUNTIME/index.cjs"
BOOTSTRAP_PATH="$DIST_RUNTIME/plugin-bootstrap.cjs"

# ── 1. Build 产物存在（index.cjs + plugin-bootstrap.cjs）────────────
echo ""
echo -e "${BLUE}[1/6] 检查 build 产物...${NC}"

if [ ! -f "$BUNDLE_PATH" ] || [ ! -f "$BOOTSTRAP_PATH" ]; then
    echo -e "${YELLOW}[WARN] 产物不完整，先运行 build...${NC}"
    cd "$RUNTIME_DIR" && npm run build
fi

if [ ! -f "$BUNDLE_PATH" ]; then
    echo -e "${RED}[ERROR] 产物不存在: $BUNDLE_PATH${NC}"
    exit 1
fi
if [ ! -f "$BOOTSTRAP_PATH" ]; then
    echo -e "${RED}[ERROR] Worker bootstrap 不存在: $BOOTSTRAP_PATH${NC}"
    echo -e "${YELLOW}[FIX] tsup entry 必须包含 plugin-bootstrap.ts，输出为 plugin-bootstrap.cjs${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] 产物存在: index.cjs + plugin-bootstrap.cjs${NC}"

# ── 2. 依赖打包检查 ─────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[2/6] 检查依赖是否打包（noExternal）...${NC}"

# 从 package.json 读取 dependencies（过滤 workspace:* 协议依赖——它们被 tsup inline，
# 包名在 bundle 中消失是预期行为，第 4 步 grep 包名检查不适用）
RUNTIME_PKG="$RUNTIME_DIR/package.json"
DEPS=$(node -e "
const p=require('$RUNTIME_PKG');
const deps=p.dependencies||{};
console.log(Object.keys(deps).filter(k=>!deps[k].startsWith('workspace:')).join('\n'));
")

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
echo -e "${BLUE}[3/6] 检查 CJS 兼容性（禁止 import.meta / fileURLToPath）...${NC}"

# 允许的 import.meta 用法：有 __dirname 兼容层或 getAppVersion/getPluginHostDir 的注释说明
# plugin-host.ts 和 plugin-version-checker.ts 有专门的 __dirname 兼容层，予以排除
IMPORTS_META=$(grep -rn "import\.meta" "$RUNTIME_DIR/src" --include="*.ts" 2>/dev/null | grep -v "plugin-host.ts\|plugin-version-checker.ts" || true)

if [ -n "$IMPORTS_META" ]; then
    echo -e "${RED}[ERROR] runtime 源码使用了 import.meta，CJS bundle 会变成 undefined：${NC}"
    echo "$IMPORTS_META" | sed 's/^/  /'
    echo -e "${YELLOW}[FIX] 使用 __dirname 或 process.cwd() 代替 import.meta.url${NC}"
    exit 1
fi

FILE_URL_USAGE=$(grep -rn "fileURLToPath" "$RUNTIME_DIR/src" --include="*.ts" 2>/dev/null | grep -v "plugin-host.ts" || true)
if [ -n "$FILE_URL_USAGE" ]; then
    echo -e "${RED}[ERROR] runtime 源码使用了 fileURLToPath（CJS 中需要 import.meta.url）：${NC}"
    echo "$FILE_URL_USAGE" | sed 's/^/  /'
    echo -e "${YELLOW}[FIX] 使用 __dirname 兼容层或 process.cwd() 代替${NC}"
    exit 1
fi

echo -e "${GREEN}[OK] 无 import.meta / fileURLToPath 引用${NC}"

# ── 4. 产物自包含验证 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[4/6] 检查产物是否包含所有依赖...${NC}"

for dep in $DEPS; do
    if [ -n "$dep" ]; then
        if ! grep -q "$dep" "$BUNDLE_PATH"; then
            echo -e "${RED}[ERROR] 产物缺少依赖 $dep（noExternal 可能遗漏）${NC}"
            exit 1
        fi
    fi
done
echo -e "${GREEN}[OK] 产物包含所有依赖${NC}"

# ── 5. plugin-bootstrap.cjs 可独立运行 ──────────────────────────────
echo ""
echo -e "${BLUE}[5/6] Worker bootstrap 可独立解析...${NC}"

# plugin-bootstrap.cjs 作为 Worker Thread 入口，必须能独立 require
# 验证：文件包含 createRequire 或 node:worker_threads，无顶层 require(index.cjs) 依赖
if ! grep -q "worker_threads" "$BOOTSTRAP_PATH"; then
    echo -e "${RED}[ERROR] plugin-bootstrap.cjs 缺少 worker_threads 引用${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] plugin-bootstrap.cjs 结构正确${NC}"

# ── 6. 运行时健康检查 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[6/6] 运行时健康检查...${NC}"

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
    __check_principle
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

    # 检查 plugin 初始化是否成功（防止 globalThis.__dirname 等错误被 try-catch 吞掉）
    if grep -q 'plugin initialization failed' /tmp/runtime-validate.log; then
        echo -e "${RED}[ERROR] Plugin 初始化失败（被 try-catch 吞掉但不应忽略）${NC}"
        echo -e "${YELLOW}日志:${NC}"
        grep 'plugin initialization failed\|plugin-host\|Required file not found' /tmp/runtime-validate.log | tail -10
        echo -e "${YELLOW}[FIX] 检查 plugin-host.ts 的 __dirname 兼容层、tsup 配置、plugin-bootstrap.cjs 是否存在${NC}"
        exit 1
    fi

    # 确认 plugins initialized 成功输出
    if grep -q 'plugins initialized' /tmp/runtime-validate.log; then
        echo -e "${GREEN}[OK] Plugin 系统初始化成功${NC}"
    else
        echo -e "${YELLOW}[WARN] 未检测到 'plugins initialized' 日志（可能无插件或被 catch）${NC}"
    fi
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