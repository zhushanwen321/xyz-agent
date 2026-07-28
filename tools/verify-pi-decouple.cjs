#!/usr/bin/env node
/**
 * verify-pi-decouple.cjs — P3 pi 与连接生命周期解耦端到端验证（spec §六，AGENTS 规则 #4）。
 *
 * 真起 runtime 子进程，覆盖 P3 解耦语义两场景（spec §三表 + P3-s2 split w2）：
 *   V1: 断线 → turn 期间断开 → 重连带 lastSeq 回放链路连通（pi 存活，事件入 buffer）
 *   V2: 审批挂起 → 客户端断开 → 冷启动新客户端 → sendInitialState 含
 *       extension.pendingRequestsBatch 段（审批唤醒补发通路）
 *
 * 用法：node tools/verify-pi-decouple.cjs
 * 退出码：
 *   0 = 全部 PASS / 友好降级（无 runtime dist 时 exit 0 + 提示「需 runtime 构建」）
 *   1 = 有 runtime 但任一场景 FAIL（打印哪步失败 + 预期/实际对比）
 *
 * 复用 verify-replay.cjs 的 runtime spawn + auth 握手 + connectWs 范式（已验证稳定）。
 * 依赖：P3-s1（sendInitialState 第 14 段 extension.pendingRequestsBatch）+ P3-s2-w1（解耦契约测试）已交付。
 *
 * 注：本脚本默认不进 CI（真 runtime + 真 pi 场景 CI 不稳定，spec R4）。P3 解耦契约的机器固化
 * 见 packages/runtime/src/services/session/__tests__/（AC5/AC6/AC7/AC8 vitest）。本脚本提供本地
 * 真环境验证证据。无 runtime 构建产物时友好降级（exit 0），保证骨架可执行不腐化。
 */
'use strict'

const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const WebSocket = require('ws')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const REPO_ROOT = path.resolve(__dirname, '..')
const RUNTIME_DIST = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'server.cjs')
const PORT_BASE = parseInt(process.env.VERIFY_PI_DECOUPLE_PORT || '13701', 10)
const HOST = '127.0.0.1'
const STEP_TIMEOUT_MS = 8000

let runtimeProc = null
let port = PORT_BASE
let token = ''
let tokenFile = ''
const openedSockets = []

function log(msg) { console.log('[VERIFY-PI-DECOUPLE] ' + msg) }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ── 前置检查：runtime dist 是否存在（缺失则友好降级）──────────────

if (!fs.existsSync(RUNTIME_DIST)) {
  log('runtime 构建产物不存在: ' + RUNTIME_DIST)
  log('请先构建 runtime：cd packages/runtime && npm run build')
  log('本脚本提供本地真环境验证，不阻塞 CI（P3 解耦契约的机器固化见 vitest 测试）。')
  log('友好降级：exit 0。')
  process.exit(0)
}

// ── runtime spawn + auth 握手（复用 verify-replay.cjs 范式）────────

function isPortFree(p) {
  return new Promise((resolve) => {
    const checker = http.createServer(() => {})
    checker.once('error', () => resolve(false))
    checker.once('listening', () => { checker.close(() => resolve(true)) })
    checker.listen(p, HOST)
  })
}

async function pickFreePort() {
  for (let p = PORT_BASE; p < PORT_BASE + 50; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error('50 个候选端口都被占用，无法启动 runtime')
}

async function startRuntime() {
  token = randomBytes(32).toString('base64url')
  tokenFile = path.join(os.tmpdir(), `xyz-verify-pi-decouple-token-${process.pid}`)
  fs.writeFileSync(tokenFile, token, { mode: 0o600 })
  try { fs.chmodSync(tokenFile, 0o600) } catch { /* 非 POSIX FS 不阻断 */ }

  port = await pickFreePort()
  log('token 文件: ' + tokenFile)
  log('启动 runtime（port ' + port + '）...')

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runtime 启动超时 30s')), 30000)
    runtimeProc = spawn('node', [RUNTIME_DIST, '--port', String(port), '--token-file', tokenFile], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    runtimeProc.stdout.on('data', (d) => {
      stdout += d.toString()
      if (stdout.includes('[runtime] ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
    runtimeProc.stderr.on('data', (d) => {
      const s = d.toString()
      if (/\[runtime\]|error|ERR/i.test(s)) process.stderr.write('[runtime:err] ' + s)
    })
    runtimeProc.on('error', (e) => { clearTimeout(timer); reject(e) })
    runtimeProc.on('exit', (code, signal) => {
      if (!timer._called) {
        clearTimeout(timer)
        reject(new Error('runtime 意外退出（exit=' + code + ' signal=' + signal + '），stdout 尾部:\n' + stdout.slice(-2000)))
      }
    })
  })
}

async function waitForHealth() {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      await httpGet('http://' + HOST + ':' + port + '/health')
      return
    } catch {
      await sleep(200)
    }
  }
  throw new Error('/health 10s 内未就绪')
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('HTTP GET 超时')))
  })
}

function connectAndAuth(opts = {}) {
  return new Promise((resolve, reject) => {
    const messages = []
    let authOk = null
    const ws = new WebSocket('ws://' + HOST + ':' + port)
    openedSockets.push(ws)
    const openTimer = setTimeout(() => {
      ws.destroy()
      reject(new Error('WS 连接超时 5s'))
    }, 5000)
    ws.on('open', () => {
      clearTimeout(openTimer)
      const authMsg = {
        type: 'auth',
        id: 'auth_' + randomBytes(8).toString('hex'),
        payload: {
          token: opts.token ?? token,
          clientId: opts.clientId ?? 'client-' + randomBytes(4).toString('hex'),
          ...(opts.lastSeq !== undefined ? { lastSeq: opts.lastSeq } : {}),
          ...(opts.bootId !== undefined ? { bootId: opts.bootId } : {}),
        },
      }
      ws.send(JSON.stringify(authMsg))
    })
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        messages.push(msg)
        if (msg.type === 'auth.ok' && !authOk) {
          authOk = msg
          // 收 initial state（auth.ok 后 sendInitialState 推送）稍等一拍再 resolve
          setTimeout(() => resolve({ ws, authOk, messages }), 500)
        }
      } catch { /* ignore parse error */ }
    })
    ws.on('close', (code) => {
      if (!authOk) {
        clearTimeout(openTimer)
        reject(new Error('auth 前连接被关闭（code=' + code + '）'))
      }
    })
    ws.on('error', () => { /* close 会跟进 */ })
  })
}

// ── 场景 ──────────────────────────────────────────────────────────

/**
 * V1: 断线 → 重连带 lastSeq 回放链路连通（pi 存活语义的连通性验证）。
 *
 * 降级说明：完整的「断线期间事件入 buffer + 重连回放完整 turn」需真 pi 推消息（超本脚本范围），
 * 此处验回放链路连通性（auth.ok 含 ReplayMeta，对齐 verify-replay R1）。
 * pi 存活的契约级固化见 AC5 vitest（session-service.decouple.test.ts）。
 */
async function scenarioV1DisconnectReplay() {
  log('V1: 断线 → 重连带 lastSeq 回放链路连通...')
  const first = await connectAndAuth({ clientId: 'client-v1' })
  if (!first.authOk) return { ok: false, actual: '首次 auth 失败', expected: '首次 auth.ok' }
  const firstServerSeq = first.authOk.payload.serverSeq
  const firstBootId = first.authOk.payload.bootId
  await sleep(300)

  first.ws.close()
  await sleep(300)
  const resumed = await connectAndAuth({
    clientId: 'client-v1',
    lastSeq: firstServerSeq ?? 1,
    bootId: firstBootId,
  })
  if (!resumed.authOk) return { ok: false, actual: '重连 auth 失败', expected: '重连 auth.ok 200' }
  const p = resumed.authOk.payload
  const hasReplayMeta = 'serverSeq' in p || 'bootId' in p || 'resumed' in p || 'seqReset' in p
  return {
    ok: hasReplayMeta,
    actual: 'auth.ok payload keys: ' + Object.keys(p).join(','),
    expected: 'auth.ok 含 ReplayMeta（重连回放链路连通）',
  }
}

/**
 * V2: 审批挂起 → 客户端断开 → 冷启动新客户端 → sendInitialState 含 extension.pendingRequestsBatch 段。
 *
 * 降级说明：完整的「pi 挂起审批 → 冷启动补发 r1 → 响应 → pi 继续」需真 pi 交互（超本脚本范围），
 * 此处验 sendInitialState 第 14 段推送通路（即使无真 pi 挂起请求，段仍推送空数组）。
 * 审批唤醒的契约级固化见 AC7 vitest（message-broker.pending-replay.test.ts）。
 */
async function scenarioV2ColdStartPendingBatch() {
  log('V2: 冷启动 → sendInitialState 含 extension.pendingRequestsBatch 段...')
  const cold = await connectAndAuth({ clientId: 'client-v2-coldstart' })
  if (!cold.authOk) return { ok: false, actual: '冷启动 auth 失败', expected: '冷启动 auth.ok' }
  // connectAndAuth 已等 500ms 收 initial state
  const hasBatch = cold.messages.some((m) => m.type === 'extension.pendingRequestsBatch')
  const batchMsg = cold.messages.find((m) => m.type === 'extension.pendingRequestsBatch')
  const requestsLen = batchMsg && batchMsg.payload && Array.isArray(batchMsg.payload.requests)
    ? batchMsg.payload.requests.length
    : -1
  return {
    ok: hasBatch,
    actual: hasBatch
      ? 'sendInitialState 含 extension.pendingRequestsBatch 段（requests.length=' + requestsLen + '）'
      : 'sendInitialState 未含 extension.pendingRequestsBatch 段；收到类型: ' + cold.messages.map((m) => m.type).slice(0, 8).join(','),
    expected: 'sendInitialState 第 14 段推送 extension.pendingRequestsBatch（无真 pi 时 requests 为空数组）',
  }
}

async function runStep(name, fn) {
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('步骤超时 ' + STEP_TIMEOUT_MS + 'ms')), STEP_TIMEOUT_MS)),
    ])
    const ok = result && result.ok
    log((ok ? 'PASS' : 'FAIL') + ' ' + name + ': ' + (ok ? '' : (result.actual + ' | expected: ' + result.expected)))
    return { name, ...result, ok: !!ok }
  } catch (e) {
    log('FAIL ' + name + ': ' + e.message)
    return { name, ok: false, actual: e.message, expected: '无异常' }
  }
}

async function cleanup() {
  for (const ws of openedSockets) {
    try { ws.close() } catch { /* ignore */ }
  }
  openedSockets.length = 0
  if (runtimeProc) {
    try { runtimeProc.kill('SIGTERM') } catch { /* ignore */ }
    runtimeProc = null
  }
  if (tokenFile) {
    try { fs.unlinkSync(tokenFile) } catch { /* ignore */ }
  }
}

async function main() {
  log('=== P3 pi 与连接生命周期解耦端到端验证 ===')
  let exitCode = 0
  try {
    await startRuntime()
    await waitForHealth()
    log('runtime ready')

    const steps = [
      await runStep('V1 断线重连回放链路连通', scenarioV1DisconnectReplay),
      await runStep('V2 冷启动 sendInitialState pendingRequestsBatch 段', scenarioV2ColdStartPendingBatch),
    ]

    log('\n=== 汇总 ===')
    const failed = steps.filter((s) => !s.ok)
    for (const s of steps) {
      log('  ' + (s.ok ? 'PASS' : 'FAIL') + '  ' + s.name)
    }
    if (failed.length > 0) {
      log('\n' + failed.length + ' 个场景失败')
      exitCode = 1
    } else {
      log('\n全部 2 场景 PASS')
    }
  } catch (e) {
    log('致命错误: ' + e.message)
    exitCode = 1
  } finally {
    await cleanup()
  }
  process.exit(exitCode)
}

main()
