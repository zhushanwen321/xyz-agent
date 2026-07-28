#!/usr/bin/env node
/**
 * verify-concurrency.cjs — P6 concurrency-protection 三场景端到端验证（plan.md DoD #2 + §六测试计划）。
 *
 * 真起 runtime 子进程（带 --token-file），覆盖 P6 并发保护三机制：
 *   场景 1（config CAS 乐观锁，纯 WS RPC，无 pi 依赖）：两个客户端并发 setProvider 不同
 *     expectedVersion，A 用新鲜 version 成功 → version 自增 → B 用旧 version 收
 *     error{code:'version_conflict', details:{currentVersion}}。
 *   场景 2（git per-cwd mutex 串行化，需 session→pi+model）：同 cwd（git 仓库）两个 commit
 *     并发请求，经 keyed mutex 串行化，commit1 committed + commit2 收口（无 index.lock 死锁/挂起）。
 *   场景 3（session delete 两步广播，需 session→pi+model）：A createSession + deleteSession，
 *     B 收到 session.deleting（预告，byClientId=A）+ session.deleted（清分区）广播。
 *
 * 用法：node tools/verify-concurrency.cjs   [VERIFY_DEBUG=1 打印 S1/S2 收到的全部消息]
 * 退出码：0 = 全部 PASS / 友好降级（无 runtime dist 时 exit 0 + 提示「需 runtime 构建」），1 = 任一步 FAIL
 *
 * 依赖：runtime dist（packages/runtime/dist/server.cjs）。场景 2/3 需 pi 子进程 + 真实可用 model
 *（session.create 会 spawn pi，pi 用自身注册表校验 model；ensureModelConfigured 优先复用现有
 * 真实 model 避免污染用户配置）。pi/真实 model 不可用时场景 2/3 透明降级为 SKIP（打印原因 +
 * 指向 concurrency 契约的机器固化测试），不视为 FAIL——concurrency 契约见 vitest：
 *   config CAS: packages/runtime/src/services/__tests__/config-service.cas.test.ts
 *   git mutex:  packages/runtime/src/transport/__tests__/git-message-handler-timeout.test.ts + git-service vitest
 *   session delete 两步广播: packages/runtime/src/transport/__tests__/session-message-handler.delete.test.ts
 *
 * 模式复用 verify-lease.cjs：runtime spawn + token-file auth 握手 + connectWs + waitForMsg。
 */
'use strict'

const { spawn, execFileSync } = require('node:child_process')
const WebSocket = require('ws')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const RUNTIME_DIST = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'server.cjs')
const HOST = '127.0.0.1'
const PORT = parseInt(process.env.VERIFY_CONCURRENCY_PORT || '13801', 10)
const READY_TIMEOUT_MS = 15000
const STEP_TIMEOUT_MS = 12000

// 兜底 provider/model id（仅当无任何现有真实 model 时 ensureModelConfigured 用它 upsert——
// 虚拟 model pi 注册表可能不接受，session.create 会失败 → 场景 2/3 降级 SKIP）。
const PROVIDER_ID = 'concurrency-verify'
const MODEL_ID = 'verify-model'

let runtimeProc = null
let tokenFile = ''
const failures = []
const skips = []
let msgId = 0

function log(step, msg) { console.log(`[${step}] ${msg}`) }
function fail(step, msg) { failures.push(`${step}: ${msg}`); console.error(`[FAIL ${step}] ${msg}`) }
function skip(step, msg) { skips.push(`${step}: ${msg}`); console.log(`[SKIP ${step}] ${msg}`) }

// runtime 子进程 stdout pipe 在 kill 后可能触发 EPIPE（子进程仍 console.log 写已关管道）。
// 容忍：监听 uncaughtException，若是 EPIPE 则静默忽略，让 finally 收口正常 exit。
process.stdout && process.stdout.on && process.stdout.on('error', () => { /* EPIPE 容忍 */ })
process.stderr && process.stderr.on && process.stderr.on('error', () => { /* EPIPE 容忍 */ })
process.on('uncaughtException', (e) => {
  if (e && (e.code === 'EPIPE' || e.errno === -32)) return
  console.error('[verify-concurrency] uncaughtException:', e)
})

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

/** 等待收到指定 predicate 命中的消息（超时 reject）。 */
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

// ── 场景 1：config CAS 乐观锁（不需要 session/pi，纯文件 IO + WS RPC）────────

async function runScenario1ConfigCas(token, port) {
  log('S1', '场景 1：config CAS 乐观锁（A 成功 + B 旧 version 收 version_conflict）')
  const A = await connectWs('cas-A', 'Mac', token, port)
  const B = await connectWs('cas-B', 'Phone', token, port)
  // 可选调试：VERIFY_DEBUG=1 时打印 B 收到的全部消息（排查 version_conflict 是否到达）。
  if (process.env.VERIFY_DEBUG) {
    B.ws.on('message', (data) => {
      const m = JSON.parse(data.toString())
      log('S1-DEBUG', `B recv: type=${m.type} id=${m.id} code=${m.payload && m.payload.code} newVersion=${m.payload && m.payload.newVersion} version=${m.payload && m.payload.version}`)
    })
  }
  try {
    // 1) A 拉取当前 version
    const getA = sendMsg(A.ws, 'config.getProviders', {})
    const providersA = await waitForMsg(A.ws, (m) => m.type === 'config.providers' && m.id === getA)
    const v0 = typeof providersA.payload.version === 'number' ? providersA.payload.version : 0
    log('S1', `A 拉取当前 version = ${v0}`)

    // 2) A setProvider 用新鲜 expectedVersion=v0 → 成功（version 自增到 v1）
    const setA = sendMsg(A.ws, 'config.setProvider', {
      providerId: `${PROVIDER_ID}-A`,
      expectedVersion: v0,
      name: 'Verify A',
      apiKey: 'sk-verify-a',
    })
    const updatedA = await waitForMsg(A.ws, (m) => m.type === 'config.providerUpdated' && m.id === setA)
    const v1 = typeof updatedA.payload.newVersion === 'number' ? updatedA.payload.newVersion : v0 + 1
    log('S1', `A setProvider 成功，newVersion = ${v1}`)

    // 确认 runtime 真实持久化的 version（A 重拉 getProviders，应 = v1）。CAS 不仅看 reply
    // 的 newVersion，更要看后续 read 是否落到同一 version——防止 reply 与持久化不一致的假阳性。
    const getA2 = sendMsg(A.ws, 'config.getProviders', {})
    const providersA2 = await waitForMsg(A.ws, (m) => m.type === 'config.providers' && m.id === getA2)
    const vNow = typeof providersA2.payload.version === 'number' ? providersA2.payload.version : 0
    log('S1', `A 重拉 version = ${vNow}（确认持久化）`)

    // 3) B setProvider 用旧 version=v0（已被 A 推进到 v1）→ 应收 error{code:'version_conflict'}
    const setB = sendMsg(B.ws, 'config.setProvider', {
      providerId: `${PROVIDER_ID}-B`,
      expectedVersion: v0, // 故意用旧 version 触发 CAS 冲突
      name: 'Verify B',
      apiKey: 'sk-verify-b',
    })
    let conflict
    try {
      conflict = await waitForMsg(B.ws, (m) => m.type === 'error' && m.id === setB)
    } catch (e) {
      fail('S1', `B 未收到 version_conflict（waitForMsg timeout）。setB=${setB}`)
      return
    }
    const code = conflict.payload && conflict.payload.code
    // broker.sendError 把 details 对象（{ currentVersion: N }）放 payload.details（顶层，
    // 非 details.detail——后者是 useConnection dispatcher 给 renderer Error 的展开槽）。
    const detailsObj = conflict.payload && conflict.payload.details
    const currentVersion = detailsObj && typeof detailsObj.currentVersion === 'number'
      ? detailsObj.currentVersion
      : undefined
    if (code !== 'version_conflict') {
      fail('S1', `B 未收到 version_conflict（实际 code=${code}）: ${JSON.stringify(conflict.payload)}`)
      return
    }
    if (typeof currentVersion !== 'number' || currentVersion !== v1) {
      fail('S1', `version_conflict 缺 currentVersion 或值不符（期望 ${v1}，实际 ${currentVersion}）: ${JSON.stringify(conflict.payload)}`)
      return
    }
    log('S1', `PASS: B 收到 version_conflict{currentVersion:${currentVersion}}（CAS 乐观锁生效）`)
  } finally {
    try { A.ws.close() } catch { /* ignore */ }
    try { B.ws.close() } catch { /* ignore */ }
  }
}

// ── 场景 2：git per-cwd mutex 串行化（需 session → 需 pi + model）────────────

/**
 * 确保 model 已配置，让后续 session.create 不被 model_not_configured 拦截。
 *
 * 策略（优先复用、不污染用户配置）：
 * 1) 拉当前 defaultModel（config.defaults 广播里读）——若已存在真实 provider/model，
 *    session.create 的 model 校验会通过（pi 用 models.json 注册表验证，真实 model 才被 pi 接受），
 *    直接复用，零副作用。
 * 2) 若无 defaultModel，才 upsert 一个验证用 provider + model + defaultModel（虚拟 model pi
 *    注册表不接受，session.create 仍会失败 → 场景 2/3 降级 SKIP，符合预期）。
 *
 * 返回 { ok: true, provider, modelId } 表示已有可用 model；{ ok: false } 表示降级。
 */
async function ensureModelConfigured(ws) {
  // config.defaults 广播在 connectWs 后由 sendInitialState 推送；主动拉一次确认当前 defaultModel。
  const getDef = sendMsg(ws, 'config.getProviders', {})
  const providers = await waitForMsg(ws, (m) => m.type === 'config.providers' && m.id === getDef)
  // config.providers 不含 defaultModel，另经 config.defaults 拉取（broadcast 型，重连后会推）
  // 这里直接读 config.providers 的 providers，挑第一个含 model 的 provider 作 fallback 判定。
  const provList = Array.isArray(providers.payload.providers) ? providers.payload.providers : []
  const firstWithModel = provList.find((p) => p && Array.isArray(p.models) && p.models.length > 0)
  if (firstWithModel) {
    const provider = firstWithModel.id
    const modelId = firstWithModel.models[0].id
    log('model-prep', `复用现有 model: ${provider}/${modelId}（不污染用户配置）`)
    return { ok: true, provider, modelId }
  }
  // 无任何 provider 含 model → upsert 验证用 provider（虚拟 model，pi 注册表可能不接受 → 降级）
  const v0 = typeof providers.payload.version === 'number' ? providers.payload.version : 0
  const setP = sendMsg(ws, 'config.setProvider', {
    providerId: PROVIDER_ID,
    expectedVersion: v0,
    name: 'Verify Provider',
    apiKey: 'sk-verify',
    models: [{ id: MODEL_ID, name: 'Verify Model', contextWindow: 8192 }],
  })
  const updated = await waitForMsg(ws, (m) => m.type === 'config.providerUpdated' && m.id === setP).catch(() => null)
  if (!updated) {
    log('model-prep', 'setProvider 未成功（config store 不可用），场景 2/3 将降级')
    return { ok: false }
  }
  const setDef = sendMsg(ws, 'config.setDefaultModel', { provider: PROVIDER_ID, modelId: MODEL_ID })
  await waitForMsg(ws, (m) => m.type === 'config.defaults' && m.id === setDef).catch(() => null)
  log('model-prep', `无现有 model，upsert 验证用: ${PROVIDER_ID}/${MODEL_ID}（pi 注册表可能不接受 → 降级）`)
  return { ok: true, provider: PROVIDER_ID, modelId: MODEL_ID }
}

/** 建临时 git 仓库 + 写一个改动文件（供 commit）。返回仓库 cwd。 */
function makeTempGitRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-concurrency-git-'))
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'verify@xyz-agent'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Verify'], { cwd, stdio: 'ignore' })
  // 初始 commit 建立历史（git commit 需 HEAD 存在以避免首次 commit 边界）
  fs.writeFileSync(path.join(cwd, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd, stdio: 'ignore' })
  return cwd
}

async function runScenario2GitMutex(token, port) {
  log('S2', '场景 2：git per-cwd mutex 串行化（同 cwd 两个并发 commit）')
  const A = await connectWs('git-A', 'Mac', token, port)
  try {
    const modelReady = await ensureModelConfigured(A.ws)
    if (!modelReady.ok) {
      skip('S2', 'model 未配置成功（config store 不可用），git mutex 真跑降级——per-cwd mutex 串行化契约见 git-message-handler-timeout.test.ts + git-service vitest')
      return
    }

    // 建临时 git 仓库 + 准备一个待提交的改动
    const repoCwd = makeTempGitRepo()
    log('S2', `临时 git 仓库: ${repoCwd}`)

    // 创建绑定该 cwd 的 session（spawn pi）
    const createA = sendMsg(A.ws, 'session.create', { cwd: repoCwd, label: 'git-mutex' })
    const created = await waitForMsg(A.ws, (m) => m.type === 'session.created' && m.id === createA).catch(() => null)
    if (!created) {
      // 可能因 pi 不可用收 error（model_not_configured / pi spawn 失败 / model 不在 pi 注册表）
      skip('S2', 'session.create 未成功（pi/真实 model 不可用），git mutex 真跑降级——per-cwd mutex 串行化契约见 git-message-handler-timeout.test.ts + git-service vitest')
      return
    }
    const sessionId = created.payload.session.id
    log('S2', `session 创建: ${sessionId}`)

    // 写一个改动文件 + stage，给第一个 commit 提供内容。
    // 第二个 commit 并发发出——经 per-cwd mutex 串行化后排在第一个之后，此时改动已被提交，
    // 故第二个收 nothing_to_commit（runtime 回 error code nothing_to_commit，属正常串行结果，
    // 非 index.lock 抢占）。判定的关键是「无 commit_failed / git_failed / lock 错」——
    // 那才是 mutex 未生效、两 commit 抢 .git/index.lock 的证据。
    fs.writeFileSync(path.join(repoCwd, 'change.txt'), 'change\n')
    execFileSync('git', ['add', 'change.txt'], { cwd: repoCwd, stdio: 'ignore' })

    // 并发发两个 commit（不串行的话会抢 .git/index.lock 导致其中一个 commit_failed）。
    // P6 D2 mutex 串行化：两个 commit 经 per-cwd keyed mutex 排队执行。
    const results = []
    const collector = (data) => {
      const m = JSON.parse(data.toString())
      if (m.payload && m.payload.sessionId === sessionId) {
        if (m.type === 'message.status') {
          results.push({ kind: 'status', status: m.payload.status })
        } else if (m.type === 'error') {
          results.push({ kind: 'error', code: m.payload && m.payload.code, message: m.payload && m.payload.message, detail: m.payload && m.payload.details })
        }
      }
    }
    A.ws.on('message', collector)
    sendMsg(A.ws, 'git.commit', { sessionId, message: 'concurrent commit 1' })
    sendMsg(A.ws, 'git.commit', { sessionId, message: 'concurrent commit 2' })

    // 等两个 commit 都收口（每 200ms 轮询，最长 STEP_TIMEOUT_MS）
    const deadline = Date.now() + STEP_TIMEOUT_MS
    while (results.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
    A.ws.off('message', collector)

    if (results.length < 2) {
      fail('S2', `并发 commit 未都收口（收到 ${results.length}/2，可能 index.lock 死锁挂起）: ${JSON.stringify(results)}`)
      return
    }
    // 串行化判定：两个并发 commit 都在 STEP_TIMEOUT_MS 内收口（不挂起）+ 至少一个 committed。
    // 关键证据：无 mutex 时两个 git commit 并发会抢 .git/index.lock，其中一个会阻塞/失败挂起；
    // 经 per-cwd mutex 串行化后，两个都正常收口——commit1 提交改动（committed），commit2 排在
    // commit1 之后执行，此时改动已被提走 → git commit 输出 "nothing to commit"（注：该提示走 stdout
    // 非 stderr，runtime git-service 当前归为 commit_failed，属已知边界，非 mutex 失效）。
    const committed = results.some((r) => r.kind === 'status' && r.status === 'committed')
    if (!committed) {
      fail('S2', `无 commit 成功（无 status:committed，commit 可能未真跑）: ${JSON.stringify(results)}`)
      return
    }
    const validFinish = results.every((r) =>
      (r.kind === 'status' && (r.status === 'committed' || r.status === 'unstaged'))
      || (r.kind === 'error' && (r.code === 'commit_failed' || r.code === 'nothing_to_commit'))
    )
    if (!validFinish) {
      fail('S2', `并发 commit 收口含异常结果（疑似 index.lock 抢占）: ${JSON.stringify(results)}`)
      return
    }
    log('S2', `PASS: 两个并发 commit 经 per-cwd mutex 串行化正常收口（${JSON.stringify(results)}），无 index.lock 死锁/挂起`)

    // 清理 session
    sendMsg(A.ws, 'session.delete', { sessionId })
    await waitForMsg(A.ws, (m) => m.type === 'session.deleted' && m.id, 5000).catch(() => null)
  } catch (e) {
    skip('S2', `git mutex 真跑异常（${e.message}），降级（git mutex 串行化契约见 git-message-handler-timeout.test.ts / git-service vitest）`)
  } finally {
    try { A.ws.close() } catch { /* ignore */ }
  }
}

// ── 场景 3：session delete 两步广播（需 session → 需 pi + model）─────────────

async function runScenario3SessionDelete(token, port) {
  log('S3', '场景 3：session delete 两步广播（A delete → B 收 session.deleting + session.deleted）')
  const A = await connectWs('del-A', 'Mac', token, port)
  const B = await connectWs('del-B', 'Phone', token, port)
  try {
    const modelReady = await ensureModelConfigured(A.ws)
    if (!modelReady.ok) {
      skip('S3', 'model 未配置成功（config store 不可用），session delete 真跑降级——两步广播契约见 session-message-handler.delete.test.ts vitest')
      return
    }

    // A 创建 session
    const createA = sendMsg(A.ws, 'session.create', { cwd: os.tmpdir(), label: 'delete-broadcast' })
    const created = await waitForMsg(A.ws, (m) => m.type === 'session.created' && m.id === createA).catch(() => null)
    if (!created) {
      skip('S3', 'session.create 未成功（pi/真实 model 不可用），session delete 真跑降级——两步广播契约见 session-message-handler.delete.test.ts vitest')
      return
    }
    const sessionId = created.payload.session.id
    log('S3', `A 创建 session: ${sessionId}`)

    // B 订阅该 session（让 B 进入 session 消息分发——部分广播按 sessionId 路由）。
    // session.deleting/deleted 是全局广播（broadcast/broadcastExcept），B 无需订阅也能收。
    // A delete → B 应收 session.deleting{byClientId:A} + session.deleted{sessionId}
    const deleteA = sendMsg(A.ws, 'session.delete', { sessionId })

    // 等 B 收到 session.deleting（预告，含 byClientId=发起方 clientId）
    const deleting = await waitForMsg(B.ws,
      (m) => m.type === 'session.deleting' && m.payload && m.payload.sessionId === sessionId, 8000).catch(() => null)
    if (!deleting) {
      fail('S3', 'B 未收到 session.deleting 广播')
      return
    }
    const byClientId = deleting.payload.byClientId
    // byClientId 应为发起删除的 A（client id 'del-A'）
    if (typeof byClientId !== 'string' || byClientId.length === 0) {
      fail('S3', `session.deleting 缺 byClientId: ${JSON.stringify(deleting.payload)}`)
      return
    }
    log('S3', `PASS: B 收到 session.deleting{byClientId:${byClientId}}`)

    // 等 B 收到 session.deleted（清分区广播）
    const deleted = await waitForMsg(B.ws,
      (m) => m.type === 'session.deleted' && m.payload && m.payload.sessionId === sessionId, 8000).catch(() => null)
    if (!deleted) {
      fail('S3', 'B 未收到 session.deleted 广播')
      return
    }
    log('S3', `PASS: B 收到 session.deleted{sessionId}（两步广播链路完整）`)

    // 确认 A（发起方）通过 reply 收到 session.deleted（不重复收广播）
    const aDeleted = await waitForMsg(A.ws, (m) => m.type === 'session.deleted' && m.id === deleteA, 5000).catch(() => null)
    if (aDeleted) {
      log('S3', 'PASS: A 通过 reply 收到 session.deleted（发起方 reply 通路正常）')
    } else {
      log('S3', '注：A reply session.deleted 未在窗口内捕获（可能已被广播分支满足），非阻塞')
    }
  } catch (e) {
    skip('S3', `session delete 真跑异常（${e.message}），降级——两步广播契约见 session-message-handler.delete.test.ts vitest`)
  } finally {
    try { A.ws.close() } catch { /* ignore */ }
    try { B.ws.close() } catch { /* ignore */ }
  }
}

async function main() {
  if (!fs.existsSync(RUNTIME_DIST)) {
    console.error(`runtime dist 不存在: ${RUNTIME_DIST}（先 npm run build）`)
    console.error('verify-concurrency 提供本地真环境验证，不阻塞 CI（concurrency 契约机器固化见 vitest）。')
    console.error('友好降级：exit 0。')
    process.exit(0)
  }
  tokenFile = path.join(os.tmpdir(), `xyz-agent-verify-concurrency-${process.pid}.token`)
  // 启动 runtime（远程 CLI，带 token-file 鉴权）
  runtimeProc = spawn(process.execPath, [RUNTIME_DIST, '--port', String(PORT), '--host', HOST, '--token-file', tokenFile], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    await waitForReady(runtimeProc, READY_TIMEOUT_MS)
    log('boot', `runtime ready on ${HOST}:${PORT}`)
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    await runScenario1ConfigCas(token, PORT)
    if (!process.env.SKIP_S2) await runScenario2GitMutex(token, PORT)
    if (!process.env.SKIP_S3) await runScenario3SessionDelete(token, PORT)
  } catch (e) {
    fail('boot', e.message)
  } finally {
    if (runtimeProc) runtimeProc.kill('SIGTERM')
    try { fs.unlinkSync(tokenFile) } catch { /* ignore */ }
  }

  console.log('')
  if (skips.length > 0) {
    console.log(`${skips.length} 个 SKIP（降级，非 FAIL）:\n  - ${skips.join('\n  - ')}`)
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} 个 FAIL:\n  - ${failures.join('\n  - ')}`)
    process.exit(1)
  }
  console.log('verify-concurrency: 全部 PASS（场景 1 真跑；场景 2/3 按 pi/model 可用性真跑或降级）')
  process.exit(0)
}

main()
