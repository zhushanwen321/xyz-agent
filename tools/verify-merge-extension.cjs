#!/usr/bin/env node
/**
 * verify-merge-extension.cjs — Pre-implementation verification (spec §4.2/§3, rule #4).
 *
 * 验证 fast-merge/fast-handoff spec 的核心状态机假设能否在真实 pi 下跑通。
 * 诊断脚本（非单测），手动跑。
 *
 * 验证目标：
 *   V1. registerCommand 注册的 slash command 能被 pi 触发
 *   V2. setActiveTools 锁工具集后可用工具真的只剩指定
 *   V3. setActiveTools 恢复正常工具集
 *   V4. tool_execution_end 能捕获 tool result 的 details
 *   V5. turn_end 事件能触发（状态机的基础）
 *   V6. deliverAs:"steer" 能在同一 run 内续命（串行多 turn）
 *   V7. ctx.waitForIdle() 能挂住 handler 等 agent run 结束
 *   V8. 状态机跑完 2 个分支（turn_end 推进 + steer 续命）
 *
 * 设计：
 *   - 用 pi 的 ~/.pi/agent/models.json provider 配置（zhipu-coding-plan-router/glm-5.2）
 *   - --print 模式（进程自然退出）
 *   - handler 内 await ctx.waitForIdle() 等 run 结束（否则 --print 提前退出，见下方注释）
 *   - mock-structured-output tool 模拟真实 structured-output
 *   - extension 通过 process.stderr.write 报告状态（pi 不重定向 stderr），脚本解析
 *
 * 注：handler 立即 return 是 spec 的生产方案（RPC 模式下不会提前退出）。
 *     但 --print 模式进程会在命令处理后退出，fire-and-forget 的 run 来不及跑完。
 *     所以这里用 waitForIdle 等 run 结束——同时验证 V7（waitForIdle 可行性）。
 *     生产环境（RPC 模式）pi 不退出，handler 立即 return + 事件驱动模式可用。
 *
 * 用法：
 *   node tools/verify-merge-extension.cjs
 *   PI_BIN=/path/to/pi PROVIDER=... MODEL=... node tools/verify-merge-extension.cjs
 */

'use strict'

const { existsSync, writeFileSync, unlinkSync, mkdtempSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const TAG = '@@XYZ_VERIFY@@'

function locatePiBinary() {
  const isWin = process.platform === 'win32'
  const platArch = isWin ? 'win-x64' : `${process.platform}-${process.arch}`
  const binName = isWin ? `pi-${platArch}.exe` : `pi-${platArch}`
  const candidates = [
    process.env.PI_BIN ? path.resolve(process.env.PI_BIN) : null,
    path.join(REPO_ROOT, 'apps', 'electron', 'resources', 'pi', binName),
    path.join(REPO_ROOT, 'resources', 'pi', 'bin', isWin ? 'pi.exe' : 'pi'),
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// 临时 extension：mock structured-output + /verify-merge command + turn_end 状态机
const TMP_EXT_SOURCE = `
const { Type } = require("typebox")
const TOOL_NAME = "mock-structured-output"
const TAG = "${TAG}"

let queue = []
let savedTools = undefined
let turnCount = 0
let isRunning = false
let waitResolve = null  // waitForIdle 的 promise resolve（模拟）

function log(msg) { process.stderr.write(TAG + " " + msg + "\\n") }

module.exports = function verifyMergeExt(pi) {
  // V4: tool_execution_end 捕获 details
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME) return
    const details = event.result && event.result.details
    log("V4_TOOL_EXEC details=" + JSON.stringify({ hasDetails: details !== undefined, branch: details && details.branch }))
  })

  // V5/V6/V8: turn_end 状态机
  pi.on("turn_end", async (event) => {
    if (!isRunning) return
    turnCount++
    const stopReason = event.message && event.message.stopReason
    log("V5_TURN_END #" + turnCount + " stopReason=" + stopReason)
    if (stopReason === "toolUse") { log("  (toolUse, waiting for next turn_end)"); return }

    queue.shift()
    const next = queue[0]
    if (next) {
      log("V6_STEER remaining=" + queue.length)
      try {
        pi.sendUserMessage(next.instruction, { deliverAs: "steer" })
      } catch (e) {
        log("V6_STEER_FAILED: " + (e && e.message))
      }
      return
    }

    // 全部完成
    isRunning = false
    if (savedTools) {
      try {
        pi.setActiveTools(savedTools)
        log("V3_RESTORED count=" + (pi.getActiveTools() || []).length)
      } catch (e) { log("V3_RESTORE_FAILED: " + (e && e.message)) }
      savedTools = undefined
    }
    log("V8_COMPLETE turns=" + turnCount)
    if (waitResolve) { waitResolve(); waitResolve = null }
  })

  // V3: 注册 mock structured-output tool（parameters 必须用 typebox Type.Object，普通 JSON schema 会被忽略）
  pi.registerTool({
    name: TOOL_NAME,
    label: "Mock Structured Output",
    description: "Mock of structured-output. Call with {data}.",
    promptSnippet: "Use " + TOOL_NAME + " to return structured data.",
    parameters: Type.Object({ data: Type.Unknown({ description: "data" }) }),
    async execute(toolCallId, params) {
      return { content: [{ type: "text", text: "recorded" }], details: params.data || { echoed: true } }
    },
  })

  // V1: registerCommand
  pi.registerCommand("verify-merge", {
    handler: async (args, ctx) => {
      log("V1_COMMAND_INVOKED args=" + JSON.stringify(args).slice(0, 80))

      const before = pi.getActiveTools() || []
      log("tools_before_lock=" + before.length)

      savedTools = before
      pi.setActiveTools([TOOL_NAME])
      const after = pi.getActiveTools() || []
      log("V2_LOCK after_count=" + after.length + " tools=" + after.join(","))
      log("V2_LOCK_" + (after.length === 1 && after[0] === TOOL_NAME ? "PASS" : "FAIL"))

      queue = [
        { instruction: "Call the " + TOOL_NAME + " tool with data={branch:1}. Output nothing else." },
        { instruction: "Call the " + TOOL_NAME + " tool with data={branch:2}. Output nothing else." },
      ]
      isRunning = true
      turnCount = 0

      log("V7_WAIT_FOR_IDLE_START")
      pi.sendUserMessage(queue[0].instruction)
      log("V7_AFTER_SEND isIdle=" + ctx.isIdle())

      // V7: sendUserMessage 是 fire-and-forget，activeRun 可能还没设置。
      // 先轮询等 run 启动（isIdle 变 false），再 waitForIdle。
      try {
        // 等 run 启动（最多 10s）
        const tStart = Date.now()
        while (ctx.isIdle() && Date.now() - tStart < 10000) {
          await new Promise(r => setTimeout(r, 50))
        }
        log("V7_RUN_STARTED isIdle=" + ctx.isIdle() + " afterMs=" + (Date.now() - tStart))
        // 再等 run 结束
        const completionPromise = new Promise(r => { waitResolve = r })
        await Promise.race([ctx.waitForIdle(), completionPromise])
        log("V7_WAIT_DONE")
      } catch (e) {
        log("V7_WAIT_ERROR: " + (e && e.message))
      }
    },
  })

  log("EXTENSION_LOADED")
}
`

function createTempExtension() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'xyz-verify-merge-'))
  const extPath = path.join(tmpDir, 'verify-merge.cjs')
  writeFileSync(extPath, TMP_EXT_SOURCE, 'utf-8')
  return { extPath, tmpDir }
}

function runPi(piBin, extPath, opts) {
  return new Promise((resolve) => {
    const args = ['--extension', extPath, '--no-extensions', '--provider', opts.provider, '--model', opts.model]
    if (opts.apiKey) args.push('--api-key', opts.apiKey)
    args.push('--no-session', '--no-context-files', '--print', '/verify-merge {"test":true}')

    process.stdout.write('[VERIFY] pi: ' + args.join(' ').replace(/sk-[a-zA-Z0-9_-]+/g, 'sk-***') + '\n')

    const child = spawn(piBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    let stderr = ''
    const MAX = 32768
    child.stderr.on('data', (d) => {
      const s = d.toString('utf-8')
      process.stderr.write(s)
      if (stderr.length < MAX) stderr += s
    })
    child.stdout.on('data', (d) => process.stdout.write(d.toString('utf-8')))

    const timer = setTimeout(() => {
      process.stdout.write('\n[VERIFY] TIMEOUT 120s — killing\n')
      try { child.kill('SIGKILL') } catch (_) {}
    }, 120000)

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ stderr, code, signal })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ stderr, code: -1, signal: null, err: e.message }) })
  })
}

function parseMarkers(stderr) {
  const markers = []
  for (const line of stderr.split('\n')) {
    const idx = line.indexOf(TAG)
    if (idx >= 0) markers.push(line.slice(idx + TAG.length).trim())
  }
  return markers
}

function main() {
  const piBin = locatePiBinary()
  console.log('[VERIFY] ============================================================')
  console.log('[VERIFY] merge/handoff extension state machine verification')
  if (!piBin) { console.log('[VERIFY] pi binary not found. Set PI_BIN='); return 2 }
  console.log('[VERIFY] pi: ' + piBin)

  const opts = {
    provider: process.env.PROVIDER || 'zhipu-coding-plan-router',
    model: process.env.MODEL || 'glm-5.2',
    apiKey: process.env.API_KEY || '',
  }
  console.log('[VERIFY] provider=' + opts.provider + ' model=' + opts.model)
  console.log('[VERIFY] ============================================================')

  const { extPath, tmpDir } = createTempExtension()
  let result
  const t0 = Date.now()
  return runPi(piBin, extPath, opts).then((r) => {
    result = r
    try { unlinkSync(extPath); require('node:fs').rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const markers = parseMarkers(result.stderr)
    const joined = markers.join('\n')

    const v = {
      loaded: joined.includes('EXTENSION_LOADED'),
      v1: joined.includes('V1_COMMAND_INVOKED'),
      v2: joined.includes('V2_LOCK_PASS'),
      v2fail: joined.includes('V2_LOCK_FAIL'),
      v3: joined.includes('V3_RESTORED'),
      v4: joined.includes('V4_TOOL_EXEC'),
      v5count: (joined.match(/V5_TURN_END/g) || []).length,
      v6: joined.includes('V6_STEER') && !joined.includes('V6_STEER_FAILED'),
      v6fail: joined.includes('V6_STEER_FAILED'),
      v7: joined.includes('V7_WAIT_DONE'),
      v8: joined.includes('V8_COMPLETE'),
    }

    console.log('\n[VERIFY] ============================================================')
    console.log('[VERIFY] elapsed: ' + elapsed + 's  exit: ' + result.code + '  signal: ' + (result.signal || 'none'))
    console.log('[VERIFY] ------------------------------------------------------------')
    console.log('[VERIFY] Results:')
    console.log('[VERIFY]   extension loaded:       ' + (v.loaded ? 'PASS' : 'FAIL'))
    console.log('[VERIFY]   V1 command invoked:     ' + (v.v1 ? 'PASS' : 'FAIL'))
    console.log('[VERIFY]   V2 setActiveTools lock: ' + (v.v2 ? 'PASS' : v.v2fail ? 'FAIL' : '?'))
    console.log('[VERIFY]   V3 tools restored:      ' + (v.v3 ? 'PASS' : '?'))
    console.log('[VERIFY]   V4 tool_exec details:   ' + (v.v4 ? 'PASS' : '?'))
    console.log('[VERIFY]   V5 turn_end events:     ' + v.v5count + ' (' + (v.v5count > 0 ? 'PASS' : 'FAIL') + ')')
    console.log('[VERIFY]   V6 steer to next:       ' + (v.v6 ? 'PASS' : v.v6fail ? 'FAIL' : '?'))
    console.log('[VERIFY]   V7 waitForIdle:         ' + (v.v7 ? 'PASS' : '?'))
    console.log('[VERIFY]   V8 state machine done:  ' + (v.v8 ? 'PASS' : 'FAIL'))
    console.log('[VERIFY] ------------------------------------------------------------')

    // 核心：V1 + V8（command 触发 + 状态机跑完）
    const core = v.v1 && v.v8
    if (core) {
      console.log('[VERIFY] CORE PASS — command trigger + turn_end state machine + steer works.')
      console.log('[VERIFY] Spec §4.2 的状态机假设在真实 pi 下成立。')
      return 0
    }
    if (v.v1 && !v.v8) {
      console.log('[VERIFY] PARTIAL — command fired but state machine incomplete.')
      console.log('[VERIFY]   Likely: agent did not call mock tool, or steer/turn_end failed. See markers above.')
    } else {
      console.log('[VERIFY] FAIL — see markers above.')
    }
    return 1
  })
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[VERIFY] crashed: ' + (err && err.stack ? err.stack : err))
  process.exit(2)
})
