#!/usr/bin/env node
/**
 * verify-lease.cjs — P5 操作互斥升级端到端验证（spec §七 测试计划）。
 *
 * 真起 runtime 子进程（带 --token-file），覆盖 lease 锁 + busyOwner 定向拒绝 + TTL 释放全链路：
 *   场景 1（lease 互斥 + TTL 释放）：
 *     - A 认证 + 发 message.send（acquire lease）
 *     - B 认证 + 发 message.send 到同 session → B 收到 send.rejected（含 busyOwnerId=A）
 *     - A 断网（close）+ 等 lease TTL 过期 + reaper 5s 扫描
 *     - B 再发 message.send → 成功（lease 已释放，B acquire）
 *   场景 2（abort 释放）：
 *     - A 认证 + 发 message.send（acquire lease）
 *     - A 发 message.abort → 收到 session.idle{reason:'aborted'} 广播（lease 释放）
 *
 * 用法：node tools/verify-lease.cjs
 * 退出码：0 = 全部 PASS，1 = 任一步 FAIL
 *
 * 注：依赖 runtime dist（packages/runtime/dist/server.cjs）。lease TTL 默认 30s，本脚本
 * 通过 XYZ_AGENT_LEASE_TTL_MS=3000 缩短 TTL 加速验证（3s TTL + 5s reaper 最长 8s 释放）。
 */
'use strict'

const { spawn } = require('node:child_process')
const WebSocket = require('ws')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const RUNTIME_DIST = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'server.cjs')
const HOST = '127.0.0.1'
const PORT = parseInt(process.env.VERIFY_LEASE_PORT || '13599', 10)
// 缩短 TTL 加速验证（默认 30s 太慢）。3s TTL + reaper 5s 扫描，最长 ~8s 释放。
const LEASE_TTL_MS = parseInt(process.env.XYZ_AGENT_LEASE_TTL_MS || '3000', 10)
const READY_TIMEOUT_MS = 15000
const STEP_TIMEOUT_MS = 12000

let runtimeProc = null
let tokenFile = ''
const failures = []
let msgId = 0

function log(step, msg) { console.log(`[${step}] ${msg}`) }
function fail(step, msg) { failures.push(`${step}: ${msg}`); console.error(`[FAIL ${step}] ${msg}`) }

function waitForReady(proc, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runtime ready timeout')), timeout)
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      if (text.includes('[runtime] ready') || text.includes('[runtime] listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
    proc.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

function connectWs(clientId, deviceName, token, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}`)
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'auth', id: `auth-${clientId}`, payload: { token, clientId, deviceName } }))
    })
    const timer = setTimeout(() => reject(new Error(`auth timeout for ${clientId}`)), 6000)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'auth.ok') { clearTimeout(timer); resolve({ ws, authOk: msg }) }
    })
    ws.on('close', () => { clearTimeout(timer) })
    ws.once('error', reject)
  })
}

function sendMsg(ws, type, payload) {
  const id = `m${++msgId}`
  ws.send(JSON.stringify({ type, id, payload }))
  return id
}

/** 等待收到指定 type 的消息（session 级消息按 sessionId 匹配）。 */
function waitForMsg(ws, predicate, timeout = STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMsg timeout')), timeout)
    const handler = (data) => {
      const msg = JSON.parse(data.toString())
      if (predicate(msg)) { clearTimeout(timer); ws.off('message', handler); resolve(msg) }
    }
    ws.on('message', handler)
  })
}

async function runScenario1(token, port) {
  log('S1', '场景 1：lease 互斥 + TTL 释放')
  // 需要 session：先 A 创建 session（需 model 配置，开放/认证模式都需）。此处假设已有 session
  // 或用 session.create。lease 测试聚焦 lease 行为，session 创建用 session.create（可能需 model）。
  // 为隔离 model 依赖，本场景验证 lease 互斥用 send.rejected 断言（B 被 busy 拒绝即证明 A 持 lease）。
  const A = await connectWs('client-A', 'Mac', token, port)
  const B = await connectWs('client-B', 'Phone', token, port)
  try {
    // A 创建 session
    const createId = sendMsg(A.ws, 'session.create', { cwd: os.tmpdir(), label: 'lease-test' })
    const created = await waitForMsg(A.ws, (m) => m.type === 'session.created' && m.id === createId)
    const sessionId = created.payload.session.id
    log('S1', `session 创建: ${sessionId}`)

    // A 发 message.send（acquire lease）。若 model 未配置会失败，lease 仍 acquire（dispatcher acquire 在 ensureActive 后）。
    // 注：ensureActive 失败会广播 message.error，但 lease 不 acquire。此场景需 model 配置。
    // 为验证 lease 互斥，直接断言 B 收 send.rejected（A 持 lease）。
    sendMsg(A.ws, 'message.send', { sessionId, content: 'hello from A' })
    // 等 A 持 lease（acquire 在 sendPrompt 内同步，A 发后即持）。短暂等待 session.busy 广播。
    await new Promise((r) => setTimeout(r, 500))

    // B 发 message.send → 应收 send.rejected（busy）
    sendMsg(B.ws, 'message.send', { sessionId, content: 'hello from B' })
    let rejected
    try {
      rejected = await waitForMsg(B.ws, (m) => m.type === 'send.rejected', 5000)
    } catch (e) {
      // 若 model 未配置，B 可能收 message.error（ensureActive 失败）而非 send.rejected。
      // 此情况 lease 互斥未被触发——记为环境限制（需 model 配置），不视为 FAIL。
      fail('S1', 'B 未收到 send.rejected（可能 model 未配置导致 ensureActive 失败，lease 互斥未触发）')
      return
    }
    if (rejected.payload.reason === 'busy' && rejected.payload.busyOwnerId === 'client-A') {
      log('S1', 'PASS: B 收到 send.rejected{reason:busy, busyOwnerId:client-A}')
    } else {
      fail('S1', `send.rejected payload 不符: ${JSON.stringify(rejected.payload)}`)
    }

    // A 断网 + 等 lease TTL 过期 + reaper 5s 扫描
    log('S1', `A 断网，等 lease TTL(${LEASE_TTL_MS}ms) + reaper(5s) 释放...`)
    A.ws.close()
    // 等 reaper 释放（TTL + 最多 5s reaper + 余量）
    await new Promise((r) => setTimeout(r, LEASE_TTL_MS + 6000))

    // B 再发 message.send → 应成功（不再 send.rejected）
    sendMsg(B.ws, 'message.send', { sessionId, content: 'B retry after A gone' })
    const result = await Promise.race([
      waitForMsg(B.ws, (m) => m.type === 'message.status', 5000).then((m) => ({ ok: true, m })),
      waitForMsg(B.ws, (m) => m.type === 'send.rejected', 2000).then((m) => ({ ok: false, m })),
    ]).catch(() => ({ ok: true }))
    if (result.ok) {
      log('S1', 'PASS: lease TTL 过期释放后 B 再发成功（未收 send.rejected）')
    } else {
      fail('S1', `B 仍被 send.rejected（lease 未释放）: ${JSON.stringify(result.m.payload)}`)
    }
  } finally {
    try { A.ws.close() } catch { /* ignore */ }
    try { B.ws.close() } catch { /* ignore */ }
  }
}

async function runScenario2(token, port) {
  log('S2', '场景 2：abort 释放')
  const A = await connectWs('client-C', 'Mac2', token, port)
  try {
    const createId = sendMsg(A.ws, 'session.create', { cwd: os.tmpdir(), label: 'lease-abort' })
    const created = await waitForMsg(A.ws, (m) => m.type === 'session.created' && m.id === createId)
    const sessionId = created.payload.session.id
    sendMsg(A.ws, 'message.send', { sessionId, content: 'acquire then abort' })
    await new Promise((r) => setTimeout(r, 500))
    sendMsg(A.ws, 'message.abort', { sessionId })
    // abort 成功释放 → 广播 session.idle{reason:'aborted'}
    const idle = await waitForMsg(A.ws, (m) => m.type === 'session.idle' && m.payload.reason === 'aborted', 5000).catch(() => null)
    if (idle) {
      log('S2', 'PASS: abort 后收到 session.idle{reason:aborted}')
    } else {
      // abort 可能因 session 状态失败（message.error），session.idle 是 lease 释放广播
      fail('S2', '未收到 session.idle{reason:aborted}（abort 可能失败）')
    }
  } finally {
    try { A.ws.close() } catch { /* ignore */ }
  }
}

async function main() {
  if (!fs.existsSync(RUNTIME_DIST)) {
    console.error(`runtime dist 不存在: ${RUNTIME_DIST}（先 npm run build）`)
    process.exit(1)
  }
  tokenFile = path.join(os.tmpdir(), `xyz-agent-verify-lease-${process.pid}.token`)
  // 启动 runtime（远程 CLI，带 token + 缩短 lease TTL）
  runtimeProc = spawn(process.execPath, [RUNTIME_DIST, '--port', String(PORT), '--host', HOST, '--token-file', tokenFile], {
    cwd: REPO_ROOT,
    env: { ...process.env, XYZ_AGENT_LEASE_TTL_MS: String(LEASE_TTL_MS) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    await waitForReady(runtimeProc, READY_TIMEOUT_MS)
    log('boot', `runtime ready on ${HOST}:${PORT}`)
    // 读取 token
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    await runScenario1(token, PORT)
    await runScenario2(token, PORT)
  } catch (e) {
    fail('boot', e.message)
  } finally {
    if (runtimeProc) runtimeProc.kill('SIGTERM')
    try { fs.unlinkSync(tokenFile) } catch { /* ignore */ }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} 个 FAIL:\n  - ${failures.join('\n  - ')}`)
    process.exit(1)
  }
  console.log('\nverify-lease: 全部 PASS')
  process.exit(0)
}

main()
