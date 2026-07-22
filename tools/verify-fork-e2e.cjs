#!/usr/bin/env node
/**
 * verify-fork-e2e.cjs — fast-fork runtime 层 E2E 验证（层 2）。
 *
 * 验证目标（spec §8.1 基础层 + §12 验收 checklist，计划文档 §3.2）：
 *   F1. session.fork RPC 返回的 SessionSummary 含 parentSession + forkEntryId
 *   F2. fork 出的 session JSONL header 含 parentSession + forkEntryId（读磁盘文件验证）
 *   F3. 磁盘扫描（config.sessions RPC）回传的 fork session Summary 含 parentSession
 *   F4. forkNotice 广播（subscribe WS push，验证收到 session.forkNotice 事件）
 *
 * 为什么不用纯 pi --mode rpc：fast-fork 的截断逻辑（session-fork.ts 的 createForkedSessionFile）
 * 在 xyz-agent runtime 层，不在 pi。必须连 xyz-agent runtime 的 WS server 发 session.fork RPC，
 * 才能验证 runtime 层的真实行为（JSONL header 写 parentSession/forkEntryId、磁盘扫描回传血缘）。
 *
 * 前置：xyz-agent runtime 运行中（dev app 或独立 runtime 进程），WS 监听 <dataDir>/runtime.port
 *       指定的端口（默认 3210，dev offset +100 → 3310）。需 provider 配置（forkSession 会校验
 *       默认 model 是否配置，未配置则报 MODEL_NOT_CONFIGURED）。但本脚本不调 LLM——只 fork
 *       （createForkedSessionFile 不调 LLM），符合 docs/testing/08-real-track-manual.md §0.2
 *       「不依赖 LLM」自动化判定标准。
 *
 * S3 预置 fork 点是环境瓶颈：session.create 建空 session 无 message entry，forkSession 需要
 * 源 session 有 JSONL 文件 + message entry。本脚本策略：
 *   1. 先连 runtime + ping（S0-S1）
 *   2. config.sessions 找一个已落盘的源 session（S2，需用户已用 app 建过会话）
 *   3. 若找到带 messages 的源 session，发 session.fork 验证 F1-F4（S3-S7）
 *   4. 若无可用源 session（新数据目录），优雅 skip F1-F4 并记录环境限制
 *
 * 用法：
 *   node tools/verify-fork-e2e.cjs                 # 自动发现 runtime.port
 *   node tools/verify-fork-e2e.cjs --port 3310     # 指定端口
 *   node tools/verify-fork-e2e.cjs --print         # 只打印将发送的 RPC，不实际连
 *   node tools/verify-fork-e2e.cjs --src-session=<id>  # 指定源 session id（跳过自动发现）
 *
 * 参照：tools/verify-merge-rpc-mode.cjs 结构 + 计划文档 §3 RPC 编排。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const TAG = '[FORK-E2E]'

// ── 参数解析 ──────────────────────────────────────────────────────
let port = null
let printOnly = false
let srcSessionId = null
for (const a of process.argv.slice(2)) {
  if (a === '--print') printOnly = true
  if (a.startsWith('--port=')) port = Number(a.slice(7))
  if (a.startsWith('--src-session=')) srcSessionId = a.slice('--src-session='.length)
}

// ── 运行时端口发现（与 runtime/src/cli/port-discovery.ts 对称）──
function discoverPort() {
  const dataDir = process.env.XYZ_AGENT_DATA_DIR || path.join(os.homedir(), '.xyz-agent')
  const portFile = path.join(dataDir, 'runtime.port')
  try {
    const raw = fs.readFileSync(portFile, 'utf-8').trim()
    const p = parseInt(raw, 10)
    if (!isNaN(p) && p > 0 && p <= 65535) return p
  } catch {
    // 文件不存在，fallback 默认端口
  }
  // dev 环境用 offset +100 (DEV_PORT_OFFSET)，默认 BASE_PORT=3210
  return 3210
}

const dataDir = process.env.XYZ_AGENT_DATA_DIR || path.join(os.homedir(), '.xyz-agent')
const sessionsDir = path.join(dataDir, 'pi', 'sessions')

if (printOnly) {
  console.log(`${TAG} ============================================================`)
  console.log(`${TAG} print mode — 不会连接 runtime`)
  console.log(`${TAG} 将发送的 RPC（顺序）:`)
  console.log(`${TAG}   S1: { type:'ping', id:'r1' }`)
  console.log(`${TAG}   S2: { type:'config.sessions', id:'r2' } → 找源 session`)
  console.log(`${TAG}   S4: { type:'session.fork', id:'r3', payload:{ srcSessionId, fromPiEntryId, includeFrom:true, label:'verify-fork-branch' } }`)
  console.log(`${TAG}   S6: { type:'config.sessions', id:'r4' } → 验证 fork session 回传`)
  console.log(`${TAG}   F2: 读 <sessionsDir>/<forkSessionFile> JSONL header`)
  console.log(`${TAG} ============================================================`)
  process.exit(0)
}

// ── WS 连接（runtime 依赖 ws，root node_modules 有）──
let WebSocket
try {
  WebSocket = require('ws')
} catch (e) {
  console.log(`${TAG} FAIL: 无法加载 ws 模块（${e.message}）。请在 repo 根目录 pnpm install。`)
  process.exit(2)
}

const targetPort = port || discoverPort()
console.log(`${TAG} ============================================================`)
console.log(`${TAG} fast-fork runtime 层 E2E 验证（spec §8.1 + §12）`)
console.log(`${TAG} dataDir: ${dataDir}`)
console.log(`${TAG} sessionsDir: ${sessionsDir}`)
console.log(`${TAG} target port: ${targetPort}${port ? ' (显式指定)' : ' (runtime.port 自动发现)'}`)

// ── 消息收发器（参照 verify-merge-rpc-mode.cjs 的 pending Map 模式）──
let rpcId = 0
const pending = new Map() // id → resolve
const pushes = [] // 收集所有非 reply 的 push 事件
let ws
let results = { F1: null, F2: null, F3: null, F4: null, S0: null, S1: null, S2: null }

function connect() {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${targetPort}`
    ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.removeAllListeners('open')
      reject(new Error(`连接 ${url} 超时（5s）`))
    }, 5000)
    ws.on('open', () => {
      clearTimeout(timeout)
      console.log(`${TAG} S0: 连接 runtime WS (${url}) PASS`)
      results.S0 = 'PASS'
      resolve()
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`连接 ${url} 失败：${err.message}`))
    })
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return // 非 JSON 行忽略
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      } else {
        // 广播事件（非 reply，无匹配 id 或 push 类型）
        pushes.push(msg)
      }
    })
  })
}

function rpc(type, payload) {
  const id = 'r' + (++rpcId)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`RPC ${type} 超时（15s）`))
    }, 15000)
    pending.set(id, (msg) => {
      clearTimeout(timeout)
      resolve(msg)
    })
    ws.send(JSON.stringify({ type, id, payload }))
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 从 config.sessions reply 里找一个可 fork 的源 session。
 * 优先选带 sessionFile（已落盘）的；需用户已用 app 建过会话产生 messages。
 */
function findSourceSession(groups) {
  const all = []
  for (const g of groups || []) {
    for (const s of g.sessions || []) {
      if (s.sessionFile) all.push(s)
    }
  }
  return all.length > 0 ? all[0] : null
}

/**
 * 读 fork session 的 JSONL header（首行 {type:'session',...}）。
 * sessionFile 路径可能相对或绝对，sessionsDir 兜底拼接。
 */
function readForkHeader(sessionFile) {
  let filePath = sessionFile
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(sessionsDir, path.basename(filePath))
  }
  if (!fs.existsSync(filePath)) {
    // 也试 sessionsDir/<sessionFile>
    const alt = path.join(sessionsDir, sessionFile)
    if (fs.existsSync(alt)) filePath = alt
    else return { error: `文件不存在: ${filePath}` }
  }
  const content = fs.readFileSync(filePath, 'utf-8')
  const firstLine = content.split('\n').find((l) => l.trim()) || ''
  try {
    return { header: JSON.parse(firstLine) }
  } catch (e) {
    return { error: `首行非 JSON: ${firstLine.slice(0, 80)}` }
  }
}

async function run() {
  // ── S0-S1: 连接 + ping ──────────────────────────────────────
  try {
    await connect()
  } catch (e) {
    console.log(`${TAG} S0: ${e.message}`)
    console.log(`${TAG} SKIP: runtime 未运行或 WS 不可达。`)
    console.log(`${TAG}       前置：启动 dev app（pnpm dev）或独立 runtime 进程，等 <dataDir>/runtime.port 写出。`)
    console.log(`${TAG} ============================================================`)
    process.exit(1)
  }

  // S1 ping
  try {
    const pong = await rpc('ping', {})
    if (pong.type === 'pong' || pong.payload !== undefined) {
      console.log(`${TAG} S1: ping/pong PASS（WS 通道通）`)
      results.S1 = 'PASS'
    } else {
      console.log(`${TAG} S1: ping reply 异常: ${JSON.stringify(pong).slice(0, 120)}`)
      results.S1 = 'FAIL'
    }
  } catch (e) {
    console.log(`${TAG} S1: ping FAIL — ${e.message}`)
    results.S1 = 'FAIL'
    cleanup(1)
    return
  }

  // ── S2: config.sessions 找源 session ──────────────────────────
  let srcSession = null
  try {
    const sessionsReply = await rpc('config.sessions', {})
    const groups = sessionsReply.payload && sessionsReply.payload.groups
    if (!groups) {
      console.log(`${TAG} S2: config.sessions reply 无 groups: ${JSON.stringify(sessionsReply.payload).slice(0, 120)}`)
      results.S2 = 'FAIL'
    } else {
      srcSession = srcSessionId
        ? (groups.flatMap((g) => g.sessions).find((s) => s.id === srcSessionId))
        : findSourceSession(groups)
      if (srcSession) {
        console.log(`${TAG} S2: 找到源 session: id=${srcSession.id} label=${srcSession.label || '(none)'} sessionFile=${srcSession.sessionFile || '(none)'}`)
        results.S2 = 'PASS'
      } else {
        console.log(`${TAG} S2: config.sessions 无已落盘 session（数据目录 ${dataDir} 为空或仅含未落盘 active session）`)
        results.S2 = 'NO_SOURCE'
      }
    }
  } catch (e) {
    console.log(`${TAG} S2: config.sessions FAIL — ${e.message}`)
    results.S2 = 'FAIL'
  }

  // ── F4 forkNotice 广播预订阅：fork 前清空 pushes ──
  pushes.length = 0

  // ── S3-S7: 若有源 session，发 fork RPC 验证 F1-F4 ─────────────
  if (!srcSession) {
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} SKIP F1-F4: 无可用源 session（S3 环境瓶颈）。`)
    console.log(`${TAG}        [需手工] 用 dev app 走一次 RT-01 流程（发条消息让 LLM 回复产生 message entry），`)
    console.log(`${TAG}        再跑本脚本，或传 --src-session=<id> 指定已落盘 session。`)
    console.log(`${TAG} ------------------------------------------------------------`)
    cleanup(results.S0 === 'PASS' && results.S1 === 'PASS' ? 0 : 1)
    return
  }

  // S4: 发 fork RPC。forkEntryId 用源 session 的某个 message entry id。
  //   无法从 config.sessions 拿到具体 message entry id——用 session.getFullHistory 取末条 message 的 piEntryId。
  let forkEntryId = null
  try {
    const histReply = await rpc('session.getFullHistory', { sessionId: srcSession.id })
    const messages = (histReply.payload && histReply.payload.messages) || []
    // 末条带 piEntryId 的 message 作 fork 点
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].piEntryId) {
        forkEntryId = messages[i].piEntryId
        break
      }
    }
    if (!forkEntryId) {
      console.log(`${TAG} S3: 源 session 无带 piEntryId 的 message（可能 session.create 的空 session）。`)
      console.log(`${TAG}     [需手工] 该 session 需有真实对话历史（LLM 生成或手工预置 JSONL）才能 fork。`)
      console.log(`${TAG} ------------------------------------------------------------`)
      console.log(`${TAG} SKIP F1-F4: 源 session 无可 fork 的 message entry（S3 环境瓶颈）。`)
      cleanup(0)
      return
    }
    console.log(`${TAG} S3: fork 点 forkEntryId=${forkEntryId}（源 session 末条带 piEntryId 的 message）`)
  } catch (e) {
    console.log(`${TAG} S3: session.getFullHistory FAIL — ${e.message}`)
    console.log(`${TAG}     [需手工] 无法读源 session 历史，可能 runtime 版本不匹配。`)
    cleanup(1)
    return
  }

  // S4: 发 session.fork
  let forkedSession = null
  try {
    const forkReply = await rpc('session.fork', {
      srcSessionId: srcSession.id,
      fromPiEntryId: forkEntryId,
      includeFrom: true,
      label: 'verify-fork-branch',
    })
    forkedSession = forkReply.payload && forkReply.payload.session
    if (!forkedSession) {
      // 可能是 error reply（如 MODEL_NOT_CONFIGURED）
      if (forkReply.payload && forkReply.payload.code === 'MODEL_NOT_CONFIGURED') {
        console.log(`${TAG} S4: session.fork FAIL — 未配置默认 model（MODEL_NOT_CONFIGURED）。`)
        console.log(`${TAG}      [需手工] 在 Settings 配置 provider + model 后重跑。`)
      } else {
        console.log(`${TAG} S4: session.fork reply 无 session: ${JSON.stringify(forkReply.payload).slice(0, 150)}`)
      }
      cleanup(1)
      return
    }
    console.log(`${TAG} S4: session.fork PASS — forkedSession.id=${forkedSession.id}`)
  } catch (e) {
    console.log(`${TAG} S4: session.fork FAIL — ${e.message}`)
    cleanup(1)
    return
  }

  // F1: 验证 fork RPC 返回的 SessionSummary 含 parentSession + forkEntryId
  if (forkedSession.parentSession != null && forkedSession.forkEntryId === forkEntryId) {
    console.log(`${TAG} F1: fork RPC 返回 parentSession="${forkedSession.parentSession}" forkEntryId="${forkedSession.forkEntryId}" PASS`)
    results.F1 = 'PASS'
  } else {
    console.log(`${TAG} F1: fork RPC 字段缺失/不匹配 — parentSession="${forkedSession.parentSession}" forkEntryId="${forkedSession.forkEntryId}"（期望 ${forkEntryId}）FAIL`)
    results.F1 = 'FAIL'
  }

  // 等一小段时间让广播到达（F4）
  await sleep(300)

  // F2: 读 fork JSONL header 验证 parentSession + forkEntryId
  const forkFile = forkedSession.sessionFile
  if (forkFile) {
    const result = readForkHeader(forkFile)
    if (result.error) {
      console.log(`${TAG} F2: 读 fork JSONL header 失败 — ${result.error}（sessionFile=${forkFile}）`)
      results.F2 = 'FAIL'
    } else {
      const h = result.header
      if (h.type === 'session' && h.parentSession != null && h.forkEntryId === forkEntryId) {
        console.log(`${TAG} F2: fork JSONL header parentSession="${h.parentSession}" forkEntryId="${h.forkEntryId}" PASS`)
        results.F2 = 'PASS'
      } else {
        console.log(`${TAG} F2: fork JSONL header 字段缺失/不匹配 — type=${h.type} parentSession="${h.parentSession}" forkEntryId="${h.forkEntryId}" FAIL`)
        results.F2 = 'FAIL'
      }
    }
  } else {
    console.log(`${TAG} F2: fork session 无 sessionFile（runtime 未回传落盘路径）FAIL`)
    results.F2 = 'FAIL'
  }

  // F3: 磁盘扫描（config.sessions）回传 fork session 含 parentSession
  try {
    const sessionsReply2 = await rpc('config.sessions', {})
    const groups2 = sessionsReply2.payload && sessionsReply2.payload.groups
    const scanned = (groups2 || []).flatMap((g) => g.sessions).find((s) => s.id === forkedSession.id)
    if (scanned && scanned.parentSession != null) {
      console.log(`${TAG} F3: 磁盘扫描 config.sessions 回传 fork session parentSession="${scanned.parentSession}" PASS`)
      results.F3 = 'PASS'
    } else if (scanned) {
      console.log(`${TAG} F3: 磁盘扫描回传 fork session 但 parentSession 缺失 FAIL（session=${JSON.stringify(scanned).slice(0, 120)}）`)
      results.F3 = 'FAIL'
    } else {
      console.log(`${TAG} F3: 磁盘扫描未找到 fork session（可能 fork session 未落盘到 config.sessions 扫描目录）FAIL`)
      results.F3 = 'FAIL'
    }
  } catch (e) {
    console.log(`${TAG} F3: config.sessions FAIL — ${e.message}`)
    results.F3 = 'FAIL'
  }

  // F4: forkNotice 广播验证
  const forkNotice = pushes.find(
    (m) => m.type === 'session.forkNotice' && m.payload && m.payload.newSessionId === forkedSession.id,
  )
  if (forkNotice) {
    const p = forkNotice.payload
    console.log(`${TAG} F4: 收到 session.forkNotice 广播 srcSessionId="${p.srcSessionId}" newSessionId="${p.newSessionId}" branchName="${p.branchName || ''}" PASS`)
    results.F4 = 'PASS'
  } else {
    console.log(`${TAG} F4: 未收到 session.forkNotice 广播（共收到 ${pushes.length} 条 push，无匹配 forkNotice）FAIL`)
    results.F4 = 'FAIL'
  }

  // ── 汇总 ──────────────────────────────────────────────────────
  console.log(`${TAG} ------------------------------------------------------------`)
  const coreChecks = ['F1', 'F2', 'F3', 'F4']
  const corePass = coreChecks.every((k) => results[k] === 'PASS')
  console.log(`${TAG} F1 fork RPC 返回字段: ${results.F1 || 'SKIP'}`)
  console.log(`${TAG} F2 JSONL header 字段: ${results.F2 || 'SKIP'}`)
  console.log(`${TAG} F3 磁盘扫描回传血缘: ${results.F3 || 'SKIP'}`)
  console.log(`${TAG} F4 forkNotice 广播: ${results.F4 || 'SKIP'}`)
  console.log(`${TAG} ============================================================`)
  if (corePass) {
    console.log(`${TAG} CORE PASS — fast-fork runtime 层 fork RPC 链路验证通过。`)
    cleanup(0)
  } else {
    console.log(`${TAG} CORE FAIL — 见上方 FAIL 项详情。`)
    cleanup(1)
  }
}

function cleanup(code) {
  try {
    if (ws) ws.close()
  } catch {}
  setTimeout(() => process.exit(code), 200)
}

run().catch((err) => {
  console.error(`${TAG} crashed: ${(err && err.stack) || err}`)
  cleanup(2)
})

// 安全超时
setTimeout(() => {
  console.log(`${TAG} 全局超时 60s — 终止`)
  cleanup(1)
}, 60000)
