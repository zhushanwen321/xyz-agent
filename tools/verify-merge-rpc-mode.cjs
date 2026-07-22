#!/usr/bin/env node
/**
 * verify-merge-rpc-mode.cjs — RPC 模式状态机验证（spec §4.2 核心未验证项）。
 *
 * verify-merge-extension.cjs 在 --print 模式 + waitForIdle 阻塞下验证了 pi API 能力，
 * 但生产方案是 RPC 模式 + handler 立即 return + 事件驱动。本脚本验证后者。
 *
 * 验证目标：
 *   R1. pi --mode rpc 能启动 + 响应 get_state（确认 RPC 通道通）
 *   R2. 发 prompt("/verify-merge") 后 RPC ack（response success）是否在 handler 立即 return 后就发
 *   R3. handler 立即 return 后，turn_end 事件是否真能驱动状态机（agent 在后台跑）
 *   R4. 串行 2 分支是否完整跑完（steer 续命在 RPC 模式有效）
 *
 * 设计：
 *   - pi --mode rpc 启动（长驻）
 *   - stdin 发 JSON 命令，stdout 逐行收 JSON 响应/事件
 *   - extension 和 verify-merge-extension.cjs 同构（mock tool + turn_end 状态机）
 *     但 handler 真的立即 return（不 await waitForIdle）
 *   - 通过 stderr 标记报告 extension 内部状态
 *
 * 用法：
 *   node tools/verify-merge-rpc-mode.cjs
 */

'use strict'

const { existsSync, writeFileSync, unlinkSync, mkdtempSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const TAG = '@@XYZ_RPC@@'

function locatePiBinary() {
  const platArch = `${process.platform}-${process.arch}`
  const binName = `pi-${platArch}`
  const candidates = [
    process.env.PI_BIN ? path.resolve(process.env.PI_BIN) : null,
    path.join(REPO_ROOT, 'apps', 'electron', 'resources', 'pi', binName),
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// extension：和 verify-merge-extension.cjs 同构，但 handler 真的立即 return
const TMP_EXT_SOURCE = `
const { Type } = require("typebox")
const TOOL_NAME = "mock-structured-output"
const TAG = "${TAG}"

// module-level 状态机
let queue = []
let savedTools = undefined
let turnCount = 0
let isRunning = false

function log(msg) { process.stderr.write(TAG + " " + msg + "\\n") }

module.exports = function verifyRpcExt(pi) {
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME) return
    log("TOOL_EXEC details=" + JSON.stringify(event.result && event.result.details))
  })

  pi.on("turn_end", async (event) => {
    if (!isRunning) return
    turnCount++
    const stopReason = event.message && event.message.stopReason
    log("TURN_END #" + turnCount + " stopReason=" + stopReason)
    if (stopReason === "toolUse") return

    queue.shift()
    const next = queue[0]
    if (next) {
      log("STEER remaining=" + queue.length)
      pi.sendUserMessage(next, { deliverAs: "steer" })
      return
    }
    isRunning = false
    if (savedTools) { pi.setActiveTools(savedTools); savedTools = undefined }
    log("COMPLETE turns=" + turnCount)
  })

  pi.registerTool({
    name: TOOL_NAME,
    label: "Mock",
    description: "Mock structured output. Call with {data}.",
    parameters: Type.Object({ data: Type.Unknown() }),
    async execute(id, params) {
      return { content: [{ type: "text", text: "ok" }], details: params.data || {} }
    },
  })

  pi.registerCommand("verify-merge", {
    handler: async (_args, _ctx) => {
      log("COMMAND_HANDLER_ENTERED")
      savedTools = pi.getActiveTools()
      pi.setActiveTools([TOOL_NAME])
      log("TOOLS_LOCKED before=" + savedTools.length + " after=" + pi.getActiveTools().length)

      queue = [
        "Call the " + TOOL_NAME + " tool with data={branch:1}. Output nothing else.",
        "Call the " + TOOL_NAME + " tool with data={branch:2}. Output nothing else.",
      ]
      isRunning = true
      turnCount = 0
      pi.sendUserMessage(queue[0])
      log("HANDLER_ABOUT_TO_RETURN (not awaiting)")
      // ★ 关键：立即 return，不等 agent run。
      // 生产方案靠 turn_end 事件在后台驱动状态机。
    },
  })

  log("EXTENSION_LOADED")
}
`

function createTempExtension() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'xyz-verify-rpc-'))
  const extPath = path.join(tmpDir, 'verify-rpc.cjs')
  writeFileSync(extPath, TMP_EXT_SOURCE, 'utf-8')
  return { extPath, tmpDir }
}

function main() {
  const piBin = locatePiBinary()
  console.log('[RPC-VERIFY] ============================================================')
  console.log('[RPC-VERIFY] RPC mode state machine verification (spec §4.2 core assumption)')
  if (!piBin) { console.log('[RPC-VERIFY] pi binary not found'); return 2 }
  console.log('[RPC-VERIFY] pi: ' + piBin)

  const provider = process.env.PROVIDER || 'zhipu-coding-plan-router'
  const model = process.env.MODEL || 'glm-5.2'
  console.log('[RPC-VERIFY] provider=' + provider + ' model=' + model)

  const { extPath, tmpDir } = createTempExtension()

  const args = [
    '--extension', extPath, '--no-extensions',
    '--provider', provider, '--model', model,
    '--no-session', '--no-context-files',
    '--mode', 'rpc',
  ]
  console.log('[RPC-VERIFY] spawning pi --mode rpc ...')

  const child = spawn(piBin, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  let rpcMsgId = 0
  const pending = new Map() // id → {resolve, type}
  let stderrBuf = ''
  let ackReceived = false
  let ackDelayMs = 0
  let promptSentAt = 0
  let complete = false
  const t0 = Date.now()

  // stdout: 逐行解析 JSON（RPC 响应 + 事件）
  let stdoutBuf = ''
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf-8')
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl)
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        handleRpcMessage(msg)
      } catch (e) {
        // 非 JSON 行（如 banner），忽略
      }
    }
  })

  child.stderr.on('data', (d) => {
    const s = d.toString('utf-8')
    process.stderr.write(s)
    stderrBuf += s
  })

  function handleRpcMessage(msg) {
    // RPC response（带 id）
    if (msg.type === 'response' && msg.id) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        p.resolve(msg)
        if (p.type === 'prompt') {
          ackReceived = true
          ackDelayMs = Date.now() - promptSentAt
          console.log('[RPC-VERIFY] R2: prompt RPC ack received, delay=' + ackDelayMs + 'ms, success=' + msg.success)
        }
      }
      return
    }
    // 事件（streaming 等）—只记录关键的
    if (msg.type === 'message_start') {
      // agent 开始干活，说明 handler return 后 run 真的启动了
    }
  }

  function sendRpc(command) {
    const id = 'r' + (++rpcMsgId)
    const payload = JSON.stringify({ ...command, id })
    return new Promise((resolve) => {
      pending.set(id, { resolve, type: command.type })
      child.stdin.write(payload + '\n')
      if (command.type === 'prompt') promptSentAt = Date.now()
    })
  }

  async function run() {
    // 等待 extension 加载
    await sleep(500)
    const loaded = stderrBuf.includes('EXTENSION_LOADED')
    console.log('[RPC-VERIFY] extension loaded: ' + (loaded ? 'YES' : 'NO (check stderr)'))
    if (!loaded) { console.log('[RPC-VERIFY] FAIL: extension not loaded'); return 1 }

    // R1: get_state 确认 RPC 通道
    const stateResp = await Promise.race([
      sendRpc({ type: 'get_state' }),
      sleep(5000).then(() => null),
    ])
    if (!stateResp || !stateResp.success) {
      console.log('[RPC-VERIFY] R1: get_state FAIL (RPC channel not working)')
      return 1
    }
    console.log('[RPC-VERIFY] R1: get_state PASS (RPC channel ok, sessionFile=' + (stateResp.data && stateResp.data.sessionFile ? 'set' : 'none') + ')')

    // R2 + R3: 发 prompt("/verify-merge") — handler 立即 return
    console.log('[RPC-VERIFY] sending prompt("/verify-merge") — handler should return immediately ...')
    const promptResp = await Promise.race([
      sendRpc({ type: 'prompt', message: '/verify-merge {"test":true}' }),
      sleep(10000).then(() => null),
    ])
    if (!promptResp) {
      console.log('[RPC-VERIFY] R2: prompt ack TIMEOUT (10s) — handler did not return')
      return 1
    }
    console.log('[RPC-VERIFY] R2: prompt ack received in ' + ackDelayMs + 'ms')
    // ack 延迟 < 1s 说明 handler 确实立即 return 了（不等 turn 跑完）
    const handlerImmediate = ackDelayMs < 1000
    console.log('[RPC-VERIFY] R2: handler returned immediately: ' + (handlerImmediate ? 'YES (<1s, good)' : 'NO (>1s, may be blocking)'))

    // R3 + R4: 等 turn_end 事件驱动状态机跑完（最长 90s）
    console.log('[RPC-VERIFY] waiting for turn_end-driven state machine (up to 90s) ...')
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      if (stderrBuf.includes('COMPLETE')) { complete = true; break }
      await sleep(200)
    }

    const turnEndCount = (stderrBuf.match(new RegExp(TAG + ' TURN_END', 'g')) || []).length
    const steerCount = (stderrBuf.match(new RegExp(TAG + ' STEER', 'g')) || []).length
    const toolExecCount = (stderrBuf.match(new RegExp(TAG + ' TOOL_EXEC', 'g')) || []).length

    console.log('[RPC-VERIFY] ------------------------------------------------------------')
    console.log('[RPC-VERIFY] R3: turn_end events: ' + turnEndCount + ' (' + (turnEndCount > 0 ? 'PASS' : 'FAIL') + ')')
    console.log('[RPC-VERIFY] R4: steer calls: ' + steerCount + ' (' + (steerCount >= 1 ? 'PASS' : '?') + ')')
    console.log('[RPC-VERIFY] R4: tool_exec captured: ' + toolExecCount)
    console.log('[RPC-VERIFY] R4: state machine complete: ' + (complete ? 'PASS' : 'FAIL/TIMEOUT'))
    console.log('[RPC-VERIFY] ------------------------------------------------------------')

    const corePass = handlerImmediate && turnEndCount > 0 && complete
    console.log('[RPC-VERIFY] ============================================================')
    if (corePass) {
      console.log('[RPC-VERIFY] ✅ CORE PASS — RPC mode: handler immediate return + turn_end event-driven state machine WORKS.')
      console.log('[RPC-VERIFY]    Spec §4.2 的生产方案（handler 立即 return + 事件驱动）在 RPC 模式下验证通过。')
      return 0
    }
    console.log('[RPC-VERIFY] ❌ CORE FAIL — see details above.')
    if (!handlerImmediate) console.log('[RPC-VERIFY]    handler did not return immediately (ack delay ' + ackDelayMs + 'ms)')
    if (turnEndCount === 0) console.log('[RPC-VERIFY]    no turn_end events — agent run did not start after handler return')
    if (!complete) console.log('[RPC-VERIFY]    state machine did not complete within 90s')
    return 1
  }

  run().then((code) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log('[RPC-VERIFY] elapsed: ' + elapsed + 's')
    try { child.kill('SIGTERM') } catch (_) {}
    try { unlinkSync(extPath); require('node:fs').rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    setTimeout(() => process.exit(code), 200)
  }).catch((err) => {
    console.error('[RPC-VERIFY] crashed: ' + (err && err.stack ? err.stack : err))
    try { child.kill('SIGKILL') } catch (_) {}
    process.exit(2)
  })

  // 安全超时
  setTimeout(() => {
    if (!complete) {
      console.log('[RPC-VERIFY] global timeout 120s — killing')
      try { child.kill('SIGKILL') } catch (_) {}
      setTimeout(() => process.exit(1), 200)
    }
  }, 120000)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

main()
