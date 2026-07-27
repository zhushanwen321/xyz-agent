#!/usr/bin/env node
/**
 * verify-remote-auth.cjs — P0 远程化端到端验证（AGENTS 规则 #4）。
 *
 * 真起 runtime 子进程（带 --token-file），覆盖完整认证握手 + file.signUrl 链路：
 *   R1: 无 auth 连接被拒（5s 内 close 4001，reason 含 auth_timeout / unauthorized / auth_required）
 *   R2: 错误 token 被拒（close 4001）
 *   R3: 正确 token 握手成功（收 auth.ok + initial state 的 app.info）
 *   R4: file.signUrl RPC 往返（收 file.signUrl:result，url 含 /file?path=&exp=&sig=）
 *   R5: GET /file 200（用签名 URL 取白名单文件，body 等于测试文件内容）
 *
 * 用法：node tools/verify-remote-auth.cjs
 * 退出码：0 = 全部 PASS，1 = 任一步 FAIL（打印哪步失败 + 预期/实际对比）
 *
 * 注：runtime 日志行 `[runtime] listening on <host>:<port>` 打印的是「请求的」端口（--port 入参），
 * 端口为 0 时实际 OS 分配端口无法从日志解析。故本脚本用固定端口 + 端口占用探测选可用端口
 * （复用 verify-terminal.cjs 的固定端口范式）。
 */
'use strict'

const { spawn, execSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const WebSocket = require('ws')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const REPO_ROOT = path.resolve(__dirname, '..')
const RUNTIME_DIST = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'index.cjs')
// 固定端口基（与 verify-terminal.cjs 同范式）：进程退出会立刻释放，正常无占用。
// 启动前探测，被占用则递增找下一个可用端口。
const PORT_BASE = parseInt(process.env.VERIFY_REMOTE_AUTH_PORT || '13591', 10)
const HOST = '127.0.0.1'
const AUTH_TIMEOUT_MS = 8000 // runtime 内部 AUTH_TIMEOUT_MS=5s，预留余量
const STEP_TIMEOUT_MS = 8000

let runtimeProc = null
let port = PORT_BASE
let token = ''
let tokenFile = ''
let testFile = ''
const openedSockets = []

function log(msg) { console.log('[VERIFY] ' + msg) }

/** 探测端口是否可用（bind 一空 server 立刻关闭）。 */
function isPortFree(p) {
  return new Promise((resolve) => {
    const checker = http.createServer(() => {})
    checker.once('error', () => resolve(false))
    checker.once('listening', () => {
      checker.close(() => resolve(true))
    })
    checker.listen(p, HOST)
  })
}

async function pickFreePort() {
  for (let p = PORT_BASE; p < PORT_BASE + 50; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error('50 个候选端口都被占用，无法启动 runtime')
}

/** 步骤 1：准备临时 token 文件 + 测试文件 + spawn runtime。 */
async function startRuntime() {
  // token 文件：32 字节随机 base64url（与 TokenManager.generate 同格式），0o600 权限。
  token = randomBytes(32).toString('base64url')
  tokenFile = path.join(os.tmpdir(), `xyz-verify-remote-auth-token-${process.pid}`)
  fs.writeFileSync(tokenFile, token, { mode: 0o600 })
  try { fs.chmodSync(tokenFile, 0o600) } catch { /* 非 POSIX FS 不阻断 */ }

  // 测试文件：放在 os.tmpdir() 下，命中 FileEndpoint 白名单前缀（tmpdir() 在 allowedPrefixes 内）。
  // 扩展名必须是图片白名单（png/jpg/...），否则 /file 返回 403。
  testFile = path.join(os.tmpdir(), `xyz-verify-remote-auth-img-${process.pid}.png`)
  const testContent = 'test image content for verify-remote-auth'
  fs.writeFileSync(testFile, testContent)

  port = await pickFreePort()
  log(`token 文件: ${tokenFile}`)
  log(`测试文件: ${testFile}`)
  log(`启动 runtime（port ${port}）...`)

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
      // runtime 量级日志很多走 stderr，只转发含 [runtime] / error 关键字的便于诊断。
      const s = d.toString()
      if (/\[runtime\]|error|ERR/i.test(s)) process.stderr.write('[runtime:err] ' + s)
    })
    runtimeProc.on('error', (e) => { clearTimeout(timer); reject(e) })
    runtimeProc.on('exit', (code, signal) => {
      if (!timer._called) {
        // ready 之前就退出
        clearTimeout(timer)
        reject(new Error(`runtime 意外退出（exit=${code} signal=${signal}），stdout 尾部:\n${stdout.slice(-2000)}`))
      }
    })
  })
}

/** 步骤 2：轮询 /health 直到 200（runtime ready 后端口可能还在 listen 初始化）。 */
async function waitForHealth() {
  const deadline = Date.now() + 10000
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      await httpGet(`http://${HOST}:${port}/health`)
      return
    } catch (e) {
      lastErr = e
      await sleep(200)
    }
  }
  throw new Error(`/health 10s 内未就绪: ${lastErr && lastErr.message}`)
}

/** HTTP GET，返回 { statusCode, body }。 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('HTTP GET 超时')))
  })
}

/**
 * 建一条 WS 连接。
 * @param {object} opts
 * @param {function=} opts.onMessage (msg) => void
 * @param {function=} opts.onClose (code, reason) => void
 * @returns {Promise<WebSocket>} open 后 resolve
 */
function connectWs(opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}`)
    openedSockets.push(ws)
    const openTimer = setTimeout(() => {
      ws.destroy()
      reject(new Error('WS 连接超时 5s'))
    }, 5000)
    ws.on('open', () => {
      clearTimeout(openTimer)
      resolve(ws)
    })
    if (opts.onMessage) ws.on('message', (raw) => {
      try { opts.onMessage(JSON.parse(raw.toString())) } catch { /* ignore parse error */ }
    })
    if (opts.onClose) ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : ''
      opts.onClose(code, reason)
    })
    ws.on('error', (e) => {
      // error 事件一般伴随 close，不在此 reject（避免 close 信息丢失）
    })
  })
}

function sendJson(ws, obj) { ws.send(JSON.stringify(obj)) }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 步骤 3：无 auth 连接被拒。
 * 连上不发任何消息，期望 5s 内 close code===4001。
 */
async function stepNoAuthRejected() {
  return new Promise((resolve) => {
    let settled = false
    let ws
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      resolve({ ok: false, actual: '超时未关闭', expected: '5s 内 close 4001' })
    }, AUTH_TIMEOUT_MS + 2000)

    connectWs({
      onClose: (code, reason) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        const ok = code === 4001
        resolve({ ok, actual: `code=${code} reason="${reason}"`, expected: 'code=4001' })
      },
    }).then((w) => { ws = w }).catch((e) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ ok: false, actual: `连接失败: ${e.message}`, expected: '连上后被 4001 关闭' })
    })
  })
}

/**
 * 步骤 4：错误 token 被拒。
 * 发 auth{token:'wrong'}，期望 close 4001。
 */
async function stepWrongTokenRejected() {
  return new Promise((resolve) => {
    let settled = false
    let ws
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      resolve({ ok: false, actual: '超时未关闭', expected: 'close 4001' })
    }, STEP_TIMEOUT_MS)

    connectWs({
      onClose: (code, reason) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        const ok = code === 4001
        resolve({ ok, actual: `code=${code} reason="${reason}"`, expected: 'code=4001' })
      },
    }).then((w) => {
      ws = w
      sendJson(ws, { type: 'auth', id: 'auth_wrong', payload: { token: 'wrong-token-xyz', clientId: 'c-wrong', deviceName: 'verify-script' } })
    }).catch((e) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ ok: false, actual: `连接失败: ${e.message}`, expected: '连上后发错误 token 被 4001 关闭' })
    })
  })
}

/**
 * 步骤 5：正确 token 握手成功。
 * 发 auth{token:<正确>}，期望收 auth.ok + 之后至少一条 initial state（app.info）。
 * 返回 { ok, actual, expected, ws, authOk, initialStateMsg }。
 */
async function stepCorrectTokenHandshake() {
  return new Promise((resolve) => {
    let settled = false
    let ws
    let authOk = null
    const initialStates = []
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({
        ok: false,
        actual: `auth.ok=${authOk ? '收到' : '未收到'}, initial states=${initialStates.length} 条`,
        expected: 'auth.ok + 至少一条 initial state',
        ws,
        authOk,
        initialStateMsg: initialStates[0],
      })
    }, STEP_TIMEOUT_MS)

    connectWs({
      onMessage: (msg) => {
        if (msg.type === 'auth.ok') {
          authOk = msg
        } else if (authOk) {
          // 认证后收到的首条非 auth.ok 即 initial state
          initialStates.push(msg)
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            const clientIdOk = authOk.payload && authOk.payload.clientId === 'c-correct'
            const hasVersion = authOk.payload && typeof authOk.payload.serverVersion === 'string'
            const ok = clientIdOk && hasVersion && initialStates.length > 0
            resolve({
              ok,
              actual: `auth.ok{clientId=${authOk.payload && authOk.payload.clientId}, serverVersion=${authOk.payload && authOk.payload.serverVersion}}, initial[0].type=${msg.type}`,
              expected: 'auth.ok{clientId=c-correct, serverVersion:string} + initial state',
              ws,
              authOk,
              initialStateMsg: msg,
            })
          }
        }
      },
      onClose: (code, reason) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve({ ok: false, actual: `连接被关闭 code=${code} reason="${reason}"`, expected: '认证通过不关闭', ws, authOk, initialStateMsg: null })
      },
    }).then((w) => {
      ws = w
      sendJson(ws, { type: 'auth', id: 'auth_ok', payload: { token, clientId: 'c-correct', deviceName: 'verify-script' } })
    }).catch((e) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ ok: false, actual: `连接失败: ${e.message}`, expected: '连上后正确 token 握手成功' })
    })
  })
}

/**
 * 步骤 6：file.signUrl RPC 往返。
 * 复用认证成功的 ws，发 file.signUrl，期望收 file.signUrl:result {url, expiresAt}。
 */
async function stepSignUrl(ws) {
  return new Promise((resolve) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, actual: '超时未收到 file.signUrl:result', expected: 'file.signUrl:result{url,expiresAt}' })
    }, STEP_TIMEOUT_MS)

    const handler = (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.id === 'fsu_1') {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        ws.off('message', handler)
        if (msg.type === 'file.signUrl:result') {
          const p = msg.payload || {}
          const urlOk = typeof p.url === 'string' && p.url.startsWith('/file?')
          const expOk = typeof p.expiresAt === 'number'
          const hasSig = typeof p.url === 'string' && p.url.includes('sig=')
          const hasPath = typeof p.url === 'string' && p.url.includes('path=')
          const hasExp = typeof p.url === 'string' && p.url.includes('exp=')
          const ok = urlOk && expOk && hasSig && hasPath && hasExp
          resolve({ ok, actual: `type=${msg.type} url=${p.url} expiresAt=${p.expiresAt}`, expected: '/file?path=&exp=&sig= 完整 URL + expiresAt:number', url: p.url, expiresAt: p.expiresAt })
        } else {
          resolve({ ok: false, actual: `type=${msg.type} payload=${JSON.stringify(msg.payload)}`, expected: 'file.signUrl:result' })
        }
      }
    }
    ws.on('message', handler)
    sendJson(ws, { type: 'file.signUrl', id: 'fsu_1', payload: { path: testFile } })
  })
}

/**
 * 步骤 7：GET /file 200。
 * 用步骤 6 拿到的 url（相对路径）拼绝对 URL，HTTP GET，期望 200 + body===测试文件内容。
 */
async function stepGetFile(signedUrl) {
  try {
    const fullUrl = `http://${HOST}:${port}${signedUrl}`
    const { statusCode, body } = await httpGet(fullUrl)
    const expected = fs.readFileSync(testFile, 'utf8')
    const ok = statusCode === 200 && body === expected
    return { ok, actual: `statusCode=${statusCode} body=${JSON.stringify(body.slice(0, 60))}`, expected: `statusCode=200 body="${expected}"` }
  } catch (e) {
    return { ok: false, actual: `异常: ${e.message}`, expected: 'GET /file 200' }
  }
}

async function run() {
  log('===========================================================')
  log('远程化 P0 端到端验证（AGENTS 规则 #4：先验证再编码）')
  log('===========================================================')

  try {
    await startRuntime()
    log('runtime ready')
    await waitForHealth()
    log('/health 200 OK')
  } catch (e) {
    log('FAIL: runtime 启动失败 — ' + e.message)
    return 1
  }

  const results = []

  // R1: 无 auth 连接被拒
  try {
    log('R1 测试无 auth 连接被拒...')
    const r = await stepNoAuthRejected()
    results.push(['R1 无 auth 被拒 (4001)', r.ok])
    log(r.ok ? '  R1 PASS: ' + r.actual : '  R1 FAIL: expected=' + r.expected + ' actual=' + r.actual)
  } catch (e) { results.push(['R1 无 auth 被拒 (4001)', false]); log('  R1 FAIL: ' + e.message) }

  // R2: 错误 token 被拒
  try {
    log('R2 测试错误 token 被拒...')
    const r = await stepWrongTokenRejected()
    results.push(['R2 错误 token 被拒 (4001)', r.ok])
    log(r.ok ? '  R2 PASS: ' + r.actual : '  R2 FAIL: expected=' + r.expected + ' actual=' + r.actual)
  } catch (e) { results.push(['R2 错误 token 被拒 (4001)', false]); log('  R2 FAIL: ' + e.message) }

  // R3: 正确 token 握手
  let handshake
  try {
    log('R3 测试正确 token 握手...')
    handshake = await stepCorrectTokenHandshake()
    results.push(['R3 正确 token 握手 (auth.ok + initial state)', handshake.ok])
    log(handshake.ok ? '  R3 PASS: ' + handshake.actual : '  R3 FAIL: expected=' + handshake.expected + ' actual=' + handshake.actual)
  } catch (e) {
    results.push(['R3 正确 token 握手 (auth.ok + initial state)', false])
    log('  R3 FAIL: ' + e.message)
    handshake = null
  }

  // R4: file.signUrl RPC
  let signResult = null
  if (handshake && handshake.ws && handshake.ws.readyState === WebSocket.OPEN) {
    try {
      log('R4 测试 file.signUrl RPC...')
      signResult = await stepSignUrl(handshake.ws)
      results.push(['R4 file.signUrl RPC 往返', signResult.ok])
      log(signResult.ok ? '  R4 PASS: ' + signResult.actual : '  R4 FAIL: expected=' + signResult.expected + ' actual=' + signResult.actual)
    } catch (e) {
      results.push(['R4 file.signUrl RPC 往返', false])
      log('  R4 FAIL: ' + e.message)
    }
  } else {
    results.push(['R4 file.signUrl RPC 往返', false])
    log('  R4 SKIP: R3 握手未成功，无法复用认证 ws')
  }

  // R5: GET /file
  if (signResult && signResult.ok && signResult.url) {
    try {
      log('R5 测试 GET /file (签名 URL)...')
      const r = await stepGetFile(signResult.url)
      results.push(['R5 GET /file 200', r.ok])
      log(r.ok ? '  R5 PASS: ' + r.actual : '  R5 FAIL: expected=' + r.expected + ' actual=' + r.actual)
    } catch (e) { results.push(['R5 GET /file 200', false]); log('  R5 FAIL: ' + e.message) }
  } else {
    results.push(['R5 GET /file 200', false])
    log('  R5 SKIP: R4 signUrl 未成功，无签名 URL')
  }

  // 汇总
  log('-----------------------------------------------------------')
  const allPass = results.every(([, ok]) => ok)
  for (const [name, ok] of results) {
    log((ok ? '  [PASS] ' : '  [FAIL] ') + name)
  }
  log('-----------------------------------------------------------')
  log(allPass ? '全部 PASS' : '有 FAIL')
  log('===========================================================')
  return allPass ? 0 : 1
}

async function teardown(code) {
  // 关闭所有 ws
  for (const ws of openedSockets) {
    try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close() } catch {}
  }
  // kill runtime
  if (runtimeProc) {
    try {
      runtimeProc.kill('SIGTERM')
      // 等 2s 退出，否则 SIGKILL
      await new Promise((resolve) => {
        const exitTimer = setTimeout(() => {
          try { runtimeProc.kill('SIGKILL') } catch {}
          resolve()
        }, 2000)
        runtimeProc.once('exit', () => { clearTimeout(exitTimer); resolve() })
      })
    } catch {}
  }
  // 清理临时文件
  for (const f of [tokenFile, testFile]) {
    if (f) { try { fs.unlinkSync(f) } catch {} }
  }
  process.exit(code)
}

run().then(teardown).catch((e) => {
  console.error('[VERIFY] crashed: ' + (e.stack || e))
  teardown(2)
})
