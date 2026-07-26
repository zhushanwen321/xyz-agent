#!/usr/bin/env node
/**
 * verify-pi-attach-rpc.cjs — 验证 pi RPC message 文本中的 file path 处理（feat-add-file-picture 前置验证）。
 *
 * 背景：
 *   xyz-agent renderer 层有一套「file inline」逻辑（extractFileContexts / shouldInlineFile /
 *   INLINE_EXTENSIONS / <file> 标签），作用是把用户引用的 file path 在送给 pi 之前展开成文件内容。
 *   想知道能否删掉这套逻辑、让 pi 在 RPC 模式下自己处理 message 文本里的 file path（自己调 read 工具）。
 *   本脚本回答这个核心问题：pi 在 rpc 模式收到含 file path 的 message 文本时，会不会自己读文件。
 *
 *   与 verify-pi-image-rpc.cjs 平行（验证 prompt.images 那条路），本脚本验证 message 文本里的
 *   file path（如 "请看 pi-verify-file.txt" 或 "pi-verify-lines.txt:L12-20"）。
 *
 * 验证目标：
 *   R1. pi --mode rpc 能启动 + 响应 get_state（RPC 通道通，沿用原 R1）
 *   R2. file path in message 文本：pi 是否调 read 工具读文件，并把文件内容反映在回复中
 *       准备：pi cwd 下创建 pi-verify-file.txt，内容含唯一标记 VERIFY-PI-FILE-PATH-XXXXX
 *       发 prompt: "请读取 pi-verify-file.txt 的内容并告诉我里面写了什么"
 *       PASS：回复含标记字符串（pi 自己 read 成功）
 *       PARTIAL：检测到 read tool_call 但回复不含标记
 *       FAIL：既没调 read 也没读到内容
 *   R3. 带行范围的 file path（pi-verify-lines.txt:L12-20）：pi 是否处理
 *       准备：pi-verify-lines.txt 30 行，第 15 行含 VERIFY-PI-LINE-15-XXXXX
 *       发 prompt: "请看 pi-verify-lines.txt:L12-20，告诉我第 15 行写了什么"
 *       PASS：回复含 VERIFY-PI-LINE-15-XXXXX
 *
 * 设计：
 *   - 沿用 verify-pi-image-rpc.cjs 的 RPC 通信框架：
 *     spawn pi 子进程 → stdin 写 JSON 命令 → stdout 逐行解析 JSON
 *     → pending Map 管理 RPC 响应（按 id）→ turn_end 事件等回合结束
 *     → get_last_assistant_text 拉取最终回复
 *   - 不监听 text_delta：RPC 模式不推 text_delta（interactive 才推），靠 turn_end + 拉取
 *   - cwd：pi spawn 时传 cwd = os.tmpdir() 下的临时目录；临时文件放该 cwd（pi 用相对路径引用）
 *   - 额外监听 tool 相关事件（tool_call / tool_execution_start / tool_execution_end）以判 R2 PARTIAL
 *
 * 用法：
 *   node tools/verify-pi-attach-rpc.cjs
 *   PROVIDER=xxx MODEL=yyy node tools/verify-pi-attach-rpc.cjs
 *
 * 退出码：0 = 全部通过；1 = 任一失败；2 = 脚本异常
 */

'use strict'

const { existsSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const TAG = '[ATTACH-VERIFY]'
const REPO_ROOT = path.resolve(__dirname, '..')

// 唯一可识别标记（避免 LLM 编造或巧合命中）
const MARKER_FILE = 'VERIFY-PI-FILE-PATH-9F3K7QXZ2A'
const MARKER_LINE = 'VERIFY-PI-LINE-15-7H2M8RWZ4B'

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function main() {
  const piBin = locatePiBinary()
  console.log(`${TAG} ============================================================`)
  console.log(`${TAG} pi RPC file-path-in-message verification (feat-add-file-picture 前置)`)
  if (!piBin) {
    console.log(`${TAG} pi binary not found (set PI_BIN or run from repo root)`)
    return 2
  }
  console.log(`${TAG} pi: ${piBin}`)

  const provider = process.env.PROVIDER || 'zhipu-coding-plan-router'
  const model = process.env.MODEL || 'glm-5.2'
  console.log(`${TAG} provider=${provider} model=${model}`)
  console.log(`${TAG} marker(file)=${MARKER_FILE}`)
  console.log(`${TAG} marker(line)=${MARKER_LINE}`)

  // 临时 cwd：os.tmpdir() 下的子目录，避免污染项目目录；脚本结束清理
  const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-attach-verify-'))
  console.log(`${TAG} tmp cwd: ${tmpCwd}`)

  // 准备临时文件
  // 1) pi-verify-file.txt：含唯一标记
  const filePath = path.join(tmpCwd, 'pi-verify-file.txt')
  writeFileSync(
    filePath,
    `This is a verification file for pi RPC attach test.\n` +
      `Secret marker line: ${MARKER_FILE}\n` +
      `End of file.\n`,
    'utf-8',
  )
  // 2) pi-verify-lines.txt：30 行，第 15 行含标记（1-based）
  const linesPath = path.join(tmpCwd, 'pi-verify-lines.txt')
  const lines = []
  for (let i = 1; i <= 30; i++) {
    if (i === 15) lines.push(`line ${i}: target marker ${MARKER_LINE}`)
    else lines.push(`line ${i}: filler content ${i}`)
  }
  writeFileSync(linesPath, lines.join('\n') + '\n', 'utf-8')

  const args = [
    '--no-extensions',
    '--provider', provider, '--model', model,
    '--no-session', '--no-context-files',
    '--mode', 'rpc',
  ]
  console.log(`${TAG} spawning pi --mode rpc (cwd=${tmpCwd}) ...`)

  const child = spawn(piBin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpCwd })

  let rpcMsgId = 0
  const pending = new Map() // id → {resolve, type}
  // 每个 prompt 的观测结果（工具调用 + 最终文本）
  const observations = {
    r2: { readCalled: false, readTargets: [], assistantText: '', turnEnded: false },
    r3: { readCalled: false, readTargets: [], assistantText: '', turnEnded: false },
  }
  let activeScope = null // 'r2' | 'r3'：标记当前在等哪个 prompt 的回合
  let stderrBuf = ''
  const t0 = Date.now()

  // stdout: 逐行解析 JSON（RPC 响应 + streaming 事件）
  let stdoutBuf = ''
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf-8')
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl)
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch (_) { continue /* 非 JSON 行（banner 等） */ }
      handleRpcMessage(msg)
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
      }
      return
    }
    // 事件流（无 id，type 标识）
    if (!msg.type) return
    const scope = activeScope ? observations[activeScope] : null

    // 工具调用相关事件：pi 调 read 工具的迹象
    // 兼容多种可能的事件名（pi 版本间可能差异）
    const t = msg.type
    if (t === 'tool_call' || t === 'tool_execution_start' || t === 'tool_use' || t === 'tool_start') {
      const name = msg.toolName || msg.tool || (msg.message && msg.message.toolName) || ''
      const input = msg.input || msg.arguments || msg.args || (msg.message && msg.message.input) || {}
      if (scope && /read/i.test(String(name))) {
        scope.readCalled = true
        const target = input.path || input.file || input.filePath || input.target || ''
        if (target) scope.readTargets.push(String(target))
        console.log(`${TAG} [${activeScope}] read tool invoked: ${name} path=${target || '(?)'}`)
      }
      return
    }
    if (t === 'tool_execution_end' || t === 'tool_result' || t === 'tool_end') {
      const name = msg.toolName || msg.tool || (msg.message && msg.message.toolName) || ''
      if (scope && /read/i.test(String(name))) {
        // 标记 read 已返回（readCalled 已由 start 事件置位）
      }
      return
    }
    // RPC 模式回合结束（不推 text_delta，需主动拉取文本）。
    // 注意：pi 在「LLM 决定调用工具」时也会发 turn_end，此时 stopReason=toolUse，
    // 回合并未真正结束——pi 会执行工具后再发起一次 LLM 调用，再发一个 turn_end。
    // 因此只有 stopReason !== 'toolUse'（endTurn / stop / maxTokens 等）才视作回合完成。
    if (t === 'turn_end') {
      const stopReason = (msg.message && msg.message.stopReason) || msg.stopReason || ''
      if (scope) {
        scope.turnCount = (scope.turnCount || 0) + 1
        console.log(`${TAG} [${activeScope}] turn_end #${scope.turnCount} stopReason=${stopReason}`)
        if (stopReason !== 'toolUse') {
          scope.turnEnded = true
        }
      } else {
        console.log(`${TAG} turn_end (no active scope) stopReason=${stopReason}`)
      }
    }
  }

  function sendRpc(command) {
    const id = 'r' + (++rpcMsgId)
    const payload = JSON.stringify({ ...command, id })
    return new Promise((resolve) => {
      pending.set(id, { resolve, type: command.type })
      child.stdin.write(payload + '\n')
    })
  }

  // 发 prompt 并等待 turn_end（最长 waitMs），再拉取最终回复文本
  async function runPrompt(scope, message, waitMs) {
    activeScope = scope
    const obs = observations[scope]
    obs.readCalled = false
    obs.readTargets = []
    obs.assistantText = ''
    obs.turnEnded = false
    obs.turnCount = 0

    const promptSentAt = Date.now()
    const ack = await Promise.race([
      sendRpc({ type: 'prompt', message }),
      sleep(15000).then(() => null),
    ])
    if (!ack) {
      console.log(`${TAG} [${scope}] prompt ack TIMEOUT (15s) — pi did not respond`)
      return null
    }
    console.log(`${TAG} [${scope}] prompt ack success=${ack.success}, delay=${Date.now() - promptSentAt}ms`)
    if (ack.success !== true) {
      console.log(`${TAG} [${scope}] prompt rejected: ${JSON.stringify(ack.error || ack.data)}`)
    }

    // 等 turn_end（最长 waitMs）
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline && !obs.turnEnded) {
      await sleep(200)
    }

    if (obs.turnEnded) {
      const textResp = await Promise.race([
        sendRpc({ type: 'get_last_assistant_text' }),
        sleep(5000).then(() => null),
      ])
      if (textResp && textResp.success) {
        obs.assistantText = (textResp.data && textResp.data.text) || ''
        console.log(`${TAG} [${scope}] fetched assistant text (${obs.assistantText.length} chars)`)
      } else {
        console.log(`${TAG} [${scope}] get_last_assistant_text failed: ${JSON.stringify(textResp && textResp.error)}`)
      }
    } else {
      console.log(`${TAG} [${scope}] no turn_end within ${waitMs}ms`)
    }
    activeScope = null
    return ack
  }

  async function run() {
    // R1: get_state 确认 RPC 通道
    const stateResp = await Promise.race([
      sendRpc({ type: 'get_state' }),
      sleep(5000).then(() => null),
    ])
    if (!stateResp || !stateResp.success) {
      console.log(`${TAG} R1: get_state FAIL (RPC channel not working)`)
      console.log(`${TAG}   stderr tail: ${stderrBuf.slice(-300)}`)
      return 1
    }
    console.log(`${TAG} R1: get_state PASS (RPC channel ok)`)

    // R2: file path in message 文本
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} R2: file path in message text (pi-verify-file.txt)`)
    await runPrompt(
      'r2',
      '请读取 pi-verify-file.txt 的内容并告诉我里面写了什么（直接把文件里的标记字符串原样复制给我）。',
      60000,
    )
    const r2Text = observations.r2.assistantText
    const r2ReplyPreview = r2Text.trim().slice(0, 200)
    console.log(`${TAG} R2 assistant reply: "${r2ReplyPreview}${r2Text.length > 200 ? '...' : ''}"`)

    // prompt 间缓冲，确保上个 prompt 的尾事件（turn_end/late tool result）已落地
    await sleep(500)

    let r2Status, r2Detail
    if (!observations.r2.turnEnded) {
      r2Status = 'FAIL'
      r2Detail = 'no turn_end within 60s — agent may have hung'
    } else if (r2Text.includes(MARKER_FILE)) {
      r2Status = 'PASS'
      r2Detail = 'pi read the file and surfaced its content (marker found in reply)'
    } else if (observations.r2.readCalled) {
      r2Status = 'PARTIAL'
      r2Detail = 'pi invoked read tool but reply lacks marker (read may have failed or LLM did not quote it)'
    } else {
      r2Status = 'FAIL'
      r2Detail = 'pi did not call read and reply lacks marker'
    }
    console.log(`${TAG} R2: ${r2Status} — ${r2Detail}`)

    // R3: 带行范围的 file path
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} R3: file path with line range (pi-verify-lines.txt:L12-20)`)
    await runPrompt(
      'r3',
      '请看 pi-verify-lines.txt:L12-20，告诉我第 15 行写了什么（直接把那一行的标记字符串原样复制给我）。',
      60000,
    )
    const r3Text = observations.r3.assistantText
    const r3ReplyPreview = r3Text.trim().slice(0, 200)
    console.log(`${TAG} R3 assistant reply: "${r3ReplyPreview}${r3Text.length > 200 ? '...' : ''}"`)

    let r3Status, r3Detail
    if (!observations.r3.turnEnded) {
      r3Status = 'FAIL'
      r3Detail = 'no turn_end within 60s — agent may have hung'
    } else if (r3Text.includes(MARKER_LINE)) {
      r3Status = 'PASS'
      r3Detail = 'pi resolved the line range and surfaced line 15 marker'
    } else if (observations.r3.readCalled) {
      r3Status = 'PARTIAL'
      r3Detail = 'pi invoked read but reply lacks line-15 marker'
    } else {
      r3Status = 'FAIL'
      r3Detail = 'pi did not call read and reply lacks line marker'
    }
    console.log(`${TAG} R3: ${r3Status} — ${r3Detail}`)

    // 综合判定
    console.log(`${TAG} ============================================================`)
    const passed = (s) => s === 'PASS' || s === 'PARTIAL'
    console.log(`${TAG} R1 PASS | R2 ${r2Status} | R3 ${r3Status}`)
    console.log(`${TAG} ------------------------------------------------------------`)
    if (r2Status === 'PASS' && r3Status === 'PASS') {
      console.log(`${TAG} ✅ FULL PASS — pi 在 RPC 模式下会自己处理 message 文本里的 file path`)
      console.log(`${TAG}    （含行范围 L12-20）。renderer 的 file inline 逻辑可考虑移除，让 pi 自己 read。`)
      return 0
    }
    if (passed(r2Status) && passed(r3Status)) {
      console.log(`${TAG} ⚠️  PARTIAL PASS — pi 调用了 read（通路通），但回复未完整引用标记。`)
      console.log(`${TAG}    可能是 LLM 表述差异或 read 部分失败；建议人工核对回复决定是否可移除 file inline。`)
      return 0
    }
    console.log(`${TAG} ❌ FAIL — pi 不会自己处理 message 文本里的 file path。`)
    console.log(`${TAG}    renderer 的 file inline 逻辑（extractFileContexts / shouldInlineFile 等）需保留，`)
    console.log(`${TAG}    或改用其它方案（如显式 @file / images 通道）。`)
    console.log(`${TAG}    R2=${r2Status} R3=${r3Status}`)
    return 1
  }

  // 清理：杀子进程 + 删临时 cwd
  function cleanup() {
    try { child.kill('SIGTERM') } catch (_) {}
    try { rmSync(tmpCwd, { recursive: true, force: true }) } catch (_) {}
  }

  run().then((code) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`${TAG} elapsed: ${elapsed}s`)
    cleanup()
    setTimeout(() => process.exit(code), 200)
  }).catch((err) => {
    console.error(`${TAG} crashed: ${err && err.stack ? err.stack : err}`)
    cleanup()
    try { child.kill('SIGKILL') } catch (_) {}
    process.exit(2)
  })

  // 全局安全超时 180s
  setTimeout(() => {
    console.log(`${TAG} global timeout 180s — killing`)
    cleanup()
    setTimeout(() => process.exit(1), 200)
  }, 180000).unref()
}

main()
