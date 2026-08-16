#!/usr/bin/env bash
# verify-plugin-e2e.sh — 插件系统非 mock 端到端验收基线（F4）
#
# 测试金字塔底部全是 mock、真实加载路径零覆盖是 F1-F4 四个 bug 的共同根因；
# 本脚本用「隔离 runtime + 真实插件文件 + 真实 WS 协议」堵这个缺口，覆盖：
#
#   A. sandbox 外部插件 boot 自动激活（F1 链路：tsx loader 传递 + sandbox fork）
#   B. plugin.toggle off/on：status 回落/恢复 + activate/deactivate 真实执行
#   C. built-in statusline 被发现并激活（plugin-registry 多形态扫描 + F3 预编译链）
#   D. onBeforeSendMessage hook 真实执行（transform 副作用 + 无 failed/timed out）
#      —— V6 验收场景（.xyz-harness/2026-08-15-perf/dev-acceptance.md）的自动化版本
#   E. 声明 permissions 的插件 boot 挂起等审批 → 运行时 approvePermissions 唤醒
#      → 毫秒级激活（权限审批唤醒链路；A2 走预批准持久化路径，E 走运行时批准路径）
#
# 运行形态：tsx 源码直跑（dev 形态，cwd=repo 根），不依赖 pnpm dev / 打包产物，
# 不占用正在跑的 dev app（随机端口 + 隔离数据目录）。
#
# 用法: bash scripts/verify-plugin-e2e.sh
# 依赖: node >= 22（全局 WebSocket）、curl、lsof、esbuild（prepare-builtin-plugins 用）
# 耗时: ~5s

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

fail() {
  echo -e "${RED}[FAIL] $1${NC}" >&2
  echo -e "${YELLOW}[定位] runtime stdout: ${RUNTIME_STDOUT:-<未创建>}${NC}" >&2
  echo -e "${YELLOW}[定位] runtime 日志目录: ${DATA_DIR:+$DATA_DIR/logs}${NC}" >&2
  if [ -f "${RUNTIME_STDOUT:-}" ]; then
    echo -e "${YELLOW}── runtime stdout 尾部 ──${NC}" >&2
    tail -30 "$RUNTIME_STDOUT" >&2
  fi
  # 失败保留现场（进程照常清理，临时目录保留供排查；成功路径才全量清理）
  PRESERVE_ON_FAIL=1
  echo -e "${YELLOW}[定位] 现场保留于: ${WORK_DIR:-<未创建>}（排查后手动删除）${NC}" >&2
  exit 1
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 0. 环境前置 ─────────────────────────────────────────────────
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo -e "${RED}[ERROR] 需要 node >= 22（全局 WebSocket 客户端），当前 $(node --version)${NC}" >&2
  echo -e "${YELLOW}[FIX] 升级 node（nvm install 22）后重试${NC}" >&2
  exit 1
fi

# tsx 解析对齐 process-control.ts：从 apps/electron（tsx 声明方）按 Node 解析算法定位，
# 适配 pnpm isolated/hoisted 两种 node_modules 布局
TSX_PKG="$(node -e "console.log(require.resolve('tsx/package.json', { paths: ['$REPO_ROOT/apps/electron'] }))")" \
  || fail "tsx 不可解析——先 pnpm install（解析基准: $REPO_ROOT/apps/electron）"
TSX_CLI="$(dirname "$TSX_PKG")/dist/cli.mjs"
[ -f "$TSX_CLI" ] || fail "tsx cli 不存在: ${TSX_CLI}（先 pnpm install）"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Plugin E2E 验收]（非 mock，真实加载路径）${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ── 1. 隔离环境准备 ─────────────────────────────────────────────
WORK_DIR="$(mktemp -d /tmp/xyz-plugin-e2e.XXXXXX)"
DATA_DIR="$WORK_DIR/data"
RUNTIME_STDOUT="$WORK_DIR/runtime-stdout.log"
RUNTIME_PID=""
PRESERVE_ON_FAIL=0

cleanup() {
  local still_running=()
  if [ -n "$RUNTIME_PID" ]; then
    # 先记子进程 PID（sandbox fork 等），kill runtime 后逐一核对，防孤儿残留
    local children
    children="$(pgrep -P "$RUNTIME_PID" 2>/dev/null || true)"
    if kill -0 "$RUNTIME_PID" 2>/dev/null; then
      kill "$RUNTIME_PID" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$RUNTIME_PID" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "$RUNTIME_PID" 2>/dev/null; then
        echo -e "${YELLOW}[WARN] runtime $RUNTIME_PID 未在 10s 内退出，SIGKILL${NC}" >&2
        kill -9 "$RUNTIME_PID" 2>/dev/null || true
      fi
    fi
    for c in $children; do
      if kill -0 "$c" 2>/dev/null; then
        echo -e "${YELLOW}[WARN] 孤儿子进程 $c，终止${NC}" >&2
        kill "$c" 2>/dev/null || true
      fi
    done
  fi
  if [ "$PRESERVE_ON_FAIL" = "1" ]; then
    echo -e "${YELLOW}[WARN] 失败现场保留: $WORK_DIR（排查后手动删除）${NC}" >&2
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$DATA_DIR/plugins/e2e-minimal" "$DATA_DIR/plugins/e2e-hook"

# 最小 sandbox 插件：activate/deactivate 各打一行（B 断言目标）
cat > "$DATA_DIR/plugins/e2e-minimal/package.json" <<'EOF'
{
  "name": "e2e-minimal",
  "version": "1.0.0",
  "type": "module",
  "xyzAgent": { "manifestVersion": 1, "main": "index.js", "activationEvents": ["onStartupFinished"], "trustLevel": "sandbox" }
}
EOF
cat > "$DATA_DIR/plugins/e2e-minimal/index.js" <<'EOF'
export async function activate() {
  console.log('[e2e-minimal] activate called')
}
export async function deactivate() {
  console.log('[e2e-minimal] deactivate called')
}
EOF

# hook 插件：onBeforeSendMessage 拦截器（D 断言目标）。v6magic → [V6-HOOK-APPLIED]
# transform（demo 插件 !important→IMPORTANT 的同款语义）
cat > "$DATA_DIR/plugins/e2e-hook/package.json" <<'EOF'
{
  "name": "e2e-hook",
  "version": "1.0.0",
  "type": "module",
  "xyzAgent": { "manifestVersion": 1, "main": "index.js", "activationEvents": ["onStartupFinished"], "trustLevel": "sandbox", "permissions": ["plugin.hooks.register"] }
}
EOF
cat > "$DATA_DIR/plugins/e2e-hook/index.js" <<'EOF'
export async function activate(context) {
  console.log('[e2e-hook] activate called')
  await context.api.hooks.onBeforeSendMessage(async (ctx) => {
    const data = ctx.data ?? {}
    const content = typeof data.content === 'string' ? data.content : ''
    console.log('[e2e-hook] onBeforeSendMessage fired: ' + content)
    if (content.includes('v6magic')) {
      console.log('[e2e-hook] transform computed')
      return { proceed: true, modifiedData: { ...data, content: content.replaceAll('v6magic', '[V6-HOOK-APPLIED]') } }
    }
    return { proceed: true }
  })
}
export async function deactivate() {
  console.log('[e2e-hook] deactivate called')
}
EOF

# 预批准 e2e-hook 的 hook 注册权限（模拟用户此前已批准；A2 覆盖「预批准持久化」路径，
# E 步的 e2e-perm 不预批准——覆盖「运行时批准唤醒」路径，两条路径并存）
cat > "$DATA_DIR/plugins/permissions.json" <<'EOF'
{"e2e-hook": ["plugin.hooks.register"]}
EOF

# 权限审批插件（E 断言目标）：声明 permissions、不预批准——boot 激活挂起等审批，
# 脚本经 WS plugin.approvePermissions 批准后应毫秒级完成激活（修复前干等 30s 超时）
mkdir -p "$DATA_DIR/plugins/e2e-perm"
cat > "$DATA_DIR/plugins/e2e-perm/package.json" <<'EOF'
{
  "name": "e2e-perm",
  "version": "1.0.0",
  "type": "module",
  "xyzAgent": { "manifestVersion": 1, "main": "index.js", "activationEvents": ["onStartupFinished"], "trustLevel": "sandbox", "permissions": ["plugin.hooks.register"] }
}
EOF
cat > "$DATA_DIR/plugins/e2e-perm/index.js" <<'EOF'
export async function activate() {
  console.log('[e2e-perm] activate called')
}
export async function deactivate() {
  console.log('[e2e-perm] deactivate called')
}
EOF

# built-in 预编译（F3 链）：statusline index.ts → index.js（幂等，全新 checkout 必需）
bash "$REPO_ROOT/scripts/prepare-builtin-plugins.sh" > "$WORK_DIR/prepare.log" 2>&1 \
  || { cat "$WORK_DIR/prepare.log" >&2; fail "prepare-builtin-plugins.sh 失败"; }

# ── 2. 起隔离 runtime ───────────────────────────────────────────
PORT=""
for _ in $(seq 1 10); do
  CANDIDATE=$(( (RANDOM % 3000) + 41000 ))
  if ! lsof -n -P -i :$CANDIDATE 2>/dev/null | grep -q LISTEN; then
    PORT=$CANDIDATE
    break
  fi
done
[ -n "$PORT" ] || fail "10 次随机端口均被占用（41000-43999），检查端口占用: lsof -nP -i :41000-43999"

cd "$REPO_ROOT"
XYZ_AGENT_DATA_DIR="$DATA_DIR" node "$TSX_CLI" "$REPO_ROOT/packages/runtime/src/index.ts" --port "$PORT" \
  > "$RUNTIME_STDOUT" 2>&1 &
RUNTIME_PID=$!

READY=false
for _ in $(seq 1 40); do
  if curl -s --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
    READY=true
    break
  fi
  kill -0 "$RUNTIME_PID" 2>/dev/null || break
  sleep 0.5
done
[ "$READY" = true ] || fail "runtime 未在 20s 内就绪（port=${PORT}, pid=${RUNTIME_PID}）"
echo -e "${GREEN}[OK] 隔离 runtime 就绪（port=${PORT}, data=${DATA_DIR}）${NC}"

# ── 3. WS 编排：list / toggle / send ────────────────────────────
# 单个 node 编排脚本完成全部 WS 交互，逐步打印 PASS/FAIL，任一步失败 exit 非 0。
cat > "$WORK_DIR/ws-flow.mjs" <<'EOF'
// 插件 e2e WS 编排：A 启动激活 → B toggle 往返 → D hook 触发前置（消息发送）
const port = process.argv[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
const pending = new Map()
let nextId = 1
const results = []

const send = (type, payload) => new Promise((resolve, reject) => {
  const id = `e2e-${nextId++}`
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ type, id, payload }))
  setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id)
      reject(new Error(`RPC 超时: ${type}`))
    }
  }, 20000)
})

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg)
  }
}

const step = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${name}]${detail ? ' ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

const listPlugins = () => send('plugin.list', {}).then((m) => m.payload.plugins)

ws.onopen = async () => {
  try {
    // ── A: boot 自动激活（等待激活完成，最多 15s）──
    let plugins = []
    for (let i = 0; i < 15; i++) {
      plugins = await listPlugins()
      const minimal = plugins.find((p) => p.pluginId === 'e2e-minimal')
      const hook = plugins.find((p) => p.pluginId === 'e2e-hook')
      const statusline = plugins.find((p) => p.pluginId === 'statusline')
      if (minimal?.status === 'active' && hook?.status === 'active' && statusline?.status === 'active') break
      await sleep(1000)
    }
    const minimal = plugins.find((p) => p.pluginId === 'e2e-minimal')
    const hook = plugins.find((p) => p.pluginId === 'e2e-hook')
    const statusline = plugins.find((p) => p.pluginId === 'statusline')
    step('A1 sandbox 插件 boot 自动激活 (e2e-minimal)', minimal?.status === 'active', `status=${minimal?.status}`)
    step('A2 带权限 sandbox 插件激活 (e2e-hook)', hook?.status === 'active', `status=${hook?.status}`)
    step('A3 built-in statusline 被发现并激活（dev 扫描修复验收）', statusline != null && statusline.status === 'active', `status=${statusline?.status ?? 'MISSING'}`)

    // ── E: 运行时权限批准唤醒（boot 挂起 → approvePermissions → 毫秒级激活）──
    // e2e-perm 未预批准，boot 激活挂起等审批。批准 RPC reply 返回即 approvePermissions
    // 完成（内部 await 了被唤醒的激活）——修复前该链路断裂，挂起只能等 30s 超时
    // （实测 plugins=30007.5ms），故耗时阈值 10s 是宽松上限（实测 ~100ms）。
    const tApprove = Date.now()
    const approveReply = await send('plugin.approvePermissions', { pluginId: 'e2e-perm', permissions: ['plugin.hooks.register'] })
    const approveElapsed = Date.now() - tApprove
    const permPlugin = approveReply.payload.plugins.find((p) => p.pluginId === 'e2e-perm')
    step('E1 运行时批准后立即激活 (e2e-perm)', permPlugin?.status === 'active', `status=${permPlugin?.status} elapsed=${approveElapsed}ms`)
    step('E2 批准唤醒毫秒级完成（< 10s，非 30s 超时路径）', approveElapsed < 10000, `${approveElapsed}ms`)

    // ── B: toggle off → status 回落 + enabled=false；再 on → 恢复 ──
    const offReply = await send('plugin.toggle', { pluginId: 'e2e-minimal', enabled: false })
    const offPlugins = offReply.payload.plugins
    const offMinimal = offPlugins.find((p) => p.pluginId === 'e2e-minimal')
    step('B1 toggle off 后 status 回落', offMinimal && offMinimal.status !== 'active' && offMinimal.enabled === false, `status=${offMinimal?.status} enabled=${offMinimal?.enabled}`)
    const onReply = await send('plugin.toggle', { pluginId: 'e2e-minimal', enabled: true })
    const onMinimal = onReply.payload.plugins.find((p) => p.pluginId === 'e2e-minimal')
    step('B2 toggle on 后 status 恢复 active', onMinimal?.status === 'active', `status=${onMinimal?.status}`)

    // ── D 前置: 发消息触发 onBeforeSendMessage（fake session：hook 先于 ensureActive 执行，
    //    SESSION_NOT_FOUND error envelope 是预期返回，副作用看 runtime 日志）──
    const sendReply = await send('message.send', { sessionId: 'e2e-fake-session', content: 'hello v6magic marker' })
    step('D1 消息已发出（fake session，error envelope 属预期）', sendReply.type === 'error' || sendReply.type === 'message.status', `reply=${sendReply.type}`)

    if (results.some((r) => !r.ok)) process.exit(1)
    console.log('WS_FLOW_DONE')
    ws.close()
    process.exit(0)
  } catch (e) {
    console.error(`FAIL [WS 编排异常] ${e.message ?? e}`)
    process.exit(1)
  }
}
ws.onerror = () => {
  console.error(`FAIL [WS 连接失败] ws://127.0.0.1:${port}`)
  process.exit(1)
}
setTimeout(() => { console.error('FAIL [WS 编排整体超时 90s]'); process.exit(1) }, 90000)
EOF

node "$WORK_DIR/ws-flow.mjs" "$PORT" | tee "$WORK_DIR/ws-flow.log" \
  || fail "WS 编排有失败步骤（见上方 FAIL 行与 $WORK_DIR/ws-flow.log）"

# 等日志行落盘（console tee 异步窗口）
sleep 1

# ── 4. 日志断言（真实副作用证据）─────────────────────────────────
assert_log() {
  local pattern="$1" label="$2"
  if grep -q "$pattern" "$RUNTIME_STDOUT"; then
    echo -e "${GREEN}[OK] $label${NC}"
  else
    fail "$label —— 日志缺少匹配 '$pattern'"
  fi
}
assert_log_absent() {
  local pattern="$1" label="$2"
  if grep -q "$pattern" "$RUNTIME_STDOUT"; then
    fail "$label —— 日志出现不应存在的 '$pattern'：$(grep "$pattern" "$RUNTIME_STDOUT" | head -3)"
  else
    echo -e "${GREEN}[OK] $label${NC}"
  fi
}

assert_log '\[e2e-minimal\] activate called' 'activate 真实执行（worker 输出经 host 转发）'
assert_log '\[e2e-minimal\] deactivate called' 'toggle off 后 deactivate 真实执行'
assert_log '\[e2e-hook\] onBeforeSendMessage fired: hello v6magic marker' 'onBeforeSendMessage hook 真实执行（收到原始消息）'
assert_log '\[e2e-hook\] transform computed' 'hook transform 副作用（v6magic → [V6-HOOK-APPLIED] 计算）'
assert_log '\[e2e-perm\] activate called' 'E 权限批准唤醒后 activate 真实执行'
assert_log_absent 'failed/timed out' 'hook 管道无 failed/timed out'
assert_log_absent 'ERR_MODULE_NOT_FOUND' '无 ESM 模块加载失败（F1 回归防护）'
assert_log_absent 'PERMISSION_DENIED' '无权限拒绝（预批准生效）'

# ── 5. 收尾 ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}[OK] Plugin E2E 验收全部通过（A 激活 / B toggle / C built-in / D hook / E 权限批准唤醒）${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
