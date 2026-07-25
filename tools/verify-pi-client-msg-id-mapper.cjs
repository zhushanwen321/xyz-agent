#!/usr/bin/env node
/**
 * verify-pi-client-msg-id-mapper.cjs — 步骤 0+1 协议预验证 gate。
 *
 * 验证 xyz-client-msg-id-mapper.js extension 的整条链：
 *   input hook (剥离标记) → appendEntry (写映射) → get_entries (读映射)
 * 确认 pi 0.80.3 真的支持这套能力。这是「客户端 message 元数据映射框架」能否落地的 gate。
 *
 * 验证目标：
 *   R1.   pi --mode rpc --extension xyz-client-msg-id-mapper.js 能启动 + 响应 get_state
 *         （extension 加载成功，无语法错 / 无 import 错）。
 *   R2a.  标记剥离：发 prompt 含 `<!--xyz:msg:<uuid>-->` + 普通文本，
 *         等 turn_end 后 get_messages 拉取 user message，断言 text 不含 `<!--xyz:msg:` 标记。
 *   R2b.  映射写入：调 get_entries，断言 entries 里有 type:"custom" 且
 *         customType:"xyz.client-msg-id" 的 entry，其 data.clientUuid === 测试 uuid，
 *         data.userEntryId 是非空字符串。
 *   R3.   映射指向正确：get_entries 返回的 message entry 里找 role:"user" 的，
 *         其 id 应 === 映射的 userEntryId。
 *
 * 设计（复用 verify-pi-attach-rpc.cjs 的 RPC 通信框架）：
 *   spawn pi 子进程 → stdin 写 JSON 命令 → stdout 逐行解析 JSON
 *   → pending Map 管理 RPC 响应（按 id）→ turn_end 事件等回合结束
 *   → get_messages / get_entries 拉取并断言。
 *   turn_end 注意：stopReason==='toolUse' 不是真回合结束（pi 会继续），只在
 *   stopReason!=='toolUse' 时视作回合完成。
 *
 * 用法：
 *   node tools/verify-pi-client-msg-id-mapper.cjs
 *   PROVIDER=xxx MODEL=yyy node tools/verify-pi-client-msg-id-mapper.cjs
 *
 * 退出码：0 = 全部通过；1 = 任一失败；2 = 脚本异常
 */

'use strict'

const { existsSync, mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const TAG = '[MSGID-VERIFY]'
const REPO_ROOT = path.resolve(__dirname, '..')
const EXTENSION_PATH = path.resolve(REPO_ROOT, 'xyz-client-msg-id-mapper.js')

// 唯一测试 uuid（满足 [0-9a-fA-F-]{36}，标准 UUID v4 格式）。
const TEST_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const MARKER_FRAGMENT = '<!--xyz:msg:'
const FULL_MARKER = `<!--xyz:msg:${TEST_UUID}-->`

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

// 把 message.content（可能是 string 或 {type:"text", text}[]）规范化为纯文本。
function messageToText(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
  }
  return ''
}

function main() {
  const piBin = locatePiBinary()
  console.log(`${TAG} ============================================================`)
  console.log(`${TAG} pi client-msg-id-mapper protocol pre-verification (gate)`)
  if (!piBin) {
    console.log(`${TAG} pi binary not found (set PI_BIN or run from repo root)`)
    return 2
  }
  if (!existsSync(EXTENSION_PATH)) {
    console.log(`${TAG} extension not found: ${EXTENSION_PATH}`)
    return 2
  }
  console.log(`${TAG} pi:         ${piBin}`)
  console.log(`${TAG} extension:  ${EXTENSION_PATH}`)
  console.log(`${TAG} test uuid:  ${TEST_UUID}`)
  console.log(`${TAG} full marker: ${FULL_MARKER}`)

  const provider = process.env.PROVIDER || 'zhipu-coding-plan-router'
  const model = process.env.MODEL || 'glm-5.2'
  console.log(`${TAG} provider=${provider} model=${model}`)

  // 临时 cwd（避免污染项目目录），脚本结束清理。
  const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-msgid-verify-'))
  console.log(`${TAG} tmp cwd: ${tmpCwd}`)

  const args = [
    '--no-extensions', // 关闭 extension 自动发现，只用下面的 --extension
    '--extension', EXTENSION_PATH,
    '--provider', provider, '--model', model,
    '--no-session', '--no-context-files',
    '--mode', 'rpc',
  ]
  console.log(`${TAG} spawning pi --mode rpc --extension xyz-client-msg-id-mapper.js ...`)

  const child = spawn(piBin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpCwd })

  let rpcMsgId = 0
  const pending = new Map() // id → {resolve}
  let stderrBuf = ''
  let turnEnded = false
  let turnStopReason = ''
  let turnCount = 0
  const t0 = Date.now()

  // stdout: 逐行解析 JSON（RPC 响应 + streaming 事件）。
  let stdoutBuf = ''
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf-8')
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl)
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch (_) { continue /* 非 JSON banner */ }
      handleRpcMessage(msg)
    }
  })

  child.stderr.on('data', (d) => {
    const s = d.toString('utf-8')
    process.stderr.write(s)
    stderrBuf += s
  })

  function handleRpcMessage(msg) {
    // RPC 响应（带 id）。
    if (msg.type === 'response' && msg.id) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        p.resolve(msg)
      }
      return
    }
    if (!msg.type) return

    // turn_end：注意 toolUse 不是真回合结束。
    if (msg.type === 'turn_end') {
      const stopReason = (msg.message && msg.message.stopReason) || msg.stopReason || ''
      turnCount++
      console.log(`${TAG} turn_end #${turnCount} stopReason=${stopReason}`)
      if (stopReason !== 'toolUse') {
        turnEnded = true
      }
    }
  }

  function sendRpc(command) {
    const id = 'r' + (++rpcMsgId)
    const payload = JSON.stringify({ ...command, id })
    return new Promise((resolve) => {
      pending.set(id, { resolve })
      child.stdin.write(payload + '\n')
    })
  }

  async function run() {
    // ----------------------------------------------------------------
    // R1: get_state 确认 RPC 通道 + extension 加载成功
    // （extension 有语法错 / import 错时 pi 启动会失败或 stderr 报错，
    //  get_state 也不会返回 success）。
    // ----------------------------------------------------------------
    const stateResp = await Promise.race([
      sendRpc({ type: 'get_state' }),
      sleep(10000).then(() => null),
    ])
    if (!stateResp || !stateResp.success) {
      console.log(`${TAG} R1: get_state FAIL (extension load failed or RPC channel broken)`)
      console.log(`${TAG}   stderr tail: ${stderrBuf.slice(-500)}`)
      return { r1: 'FAIL', r2a: 'SKIP', r2b: 'SKIP', r3: 'SKIP' }
    }
    console.log(`${TAG} R1: get_state PASS (extension loaded, RPC ok)`)

    // ----------------------------------------------------------------
    // R2: 发 prompt 含标记 + 普通文本
    // ----------------------------------------------------------------
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} R2: prompt with marker + "What is 2+2? Reply with just the number."`)
    const promptText = `What is 2+2? Reply with just the number. ${FULL_MARKER}`
    turnEnded = false
    turnStopReason = ''
    turnCount = 0

    const promptSentAt = Date.now()
    const ack = await Promise.race([
      sendRpc({ type: 'prompt', message: promptText }),
      sleep(15000).then(() => null),
    ])
    if (!ack) {
      console.log(`${TAG} R2: prompt ack TIMEOUT (15s) — pi did not respond`)
      return { r1: 'PASS', r2a: 'FAIL', r2b: 'FAIL', r3: 'FAIL' }
    }
    console.log(`${TAG} R2: prompt ack success=${ack.success}, delay=${Date.now() - promptSentAt}ms`)
    if (ack.success !== true) {
      console.log(`${TAG} R2: prompt rejected: ${JSON.stringify(ack.error || ack.data)}`)
      return { r1: 'PASS', r2a: 'FAIL', r2b: 'FAIL', r3: 'FAIL' }
    }

    // 等 turn_end（最长 90s — 真实 LLM 调用，留余量）。
    const deadline = Date.now() + 90000
    while (Date.now() < deadline && !turnEnded) {
      await sleep(200)
    }
    if (!turnEnded) {
      console.log(`${TAG} R2: no turn_end within 90s — agent may have hung`)
      console.log(`${TAG}   stderr tail: ${stderrBuf.slice(-300)}`)
      return { r1: 'PASS', r2a: 'FAIL', r2b: 'FAIL', r3: 'FAIL' }
    }
    console.log(`${TAG} R2: turn ended (${((Date.now() - promptSentAt) / 1000).toFixed(1)}s)`)

    // 给 message_start / turn_end hook flush 一点时间（hook 是同步追加 entry，
    // 但保险起见等 300ms）。
    await sleep(300)

    // ----------------------------------------------------------------
    // R2a: 标记剥离 — get_messages 拉 user message，断言不含标记
    // ----------------------------------------------------------------
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} R2a: tag stripped? (get_messages → assert user text has no marker)`)
    const msgsResp = await Promise.race([
      sendRpc({ type: 'get_messages' }),
      sleep(5000).then(() => null),
    ])
    let r2aStatus = 'FAIL'
    let r2aDetail = ''
    let userEntryIdFromMessages = null
    if (!msgsResp || !msgsResp.success) {
      r2aDetail = `get_messages failed: ${JSON.stringify(msgsResp && msgsResp.error)}`
    } else {
      const messages = (msgsResp.data && msgsResp.data.messages) || []
      // 找最后一个 user message（理论上就是刚发的那条）。
      const userMsgs = messages.filter((m) => m && m.role === 'user')
      const lastUser = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : null
      if (!lastUser) {
        r2aDetail = 'no user message found in get_messages result'
      } else {
        const userText = messageToText(lastUser)
        const previewLen = 120
        const preview = userText.length > previewLen ? userText.slice(0, previewLen) + '...' : userText
        console.log(`${TAG} R2a: last user message text: "${preview}"`)
        if (userText.includes(MARKER_FRAGMENT) || userText.includes(TEST_UUID)) {
          r2aStatus = 'FAIL'
          r2aDetail = 'user message text STILL contains the marker (transform did not strip it)'
        } else {
          r2aStatus = 'PASS'
          r2aDetail = 'user message text is clean (marker stripped by input hook)'
        }
        // 记下 user message 的 entry id（用于 R3 交叉验证）—— 注意 get_messages
        // 返回的是 AgentMessage，没有 entry id；需要从 get_entries 找。
      }
    }
    console.log(`${TAG} R2a: ${r2aStatus} — ${r2aDetail}`)

    // ----------------------------------------------------------------
    // R2b: 映射写入 — get_entries 断言含 xyz.client-msg-id custom entry
    // ----------------------------------------------------------------
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} R2b: mapping persisted? (get_entries → assert custom entry exists)`)
    const entriesResp = await Promise.race([
      sendRpc({ type: 'get_entries' }),
      sleep(5000).then(() => null),
    ])
    let r2bStatus = 'FAIL'
    let r2bDetail = ''
    let mappedUserEntryId = null
    let allEntries = []
    if (!entriesResp || !entriesResp.success) {
      r2bDetail = `get_entries failed: ${JSON.stringify(entriesResp && entriesResp.error)}`
    } else {
      allEntries = (entriesResp.data && entriesResp.data.entries) || []
      const leafId = entriesResp.data && entriesResp.data.leafId
      console.log(`${TAG} R2b: get_entries returned ${allEntries.length} entries, leafId=${leafId}`)
      const mappingEntries = allEntries.filter(
        (e) => e && e.type === 'custom' && e.customType === 'xyz.client-msg-id',
      )
      if (mappingEntries.length === 0) {
        r2bDetail = 'no custom entry with customType="xyz.client-msg-id" found (appendEntry did not persist)'
      } else {
        // 取最后一条（防止历史脏数据）。
        const mapping = mappingEntries[mappingEntries.length - 1]
        const data = mapping.data || {}
        console.log(`${TAG} R2b: mapping entry data = ${JSON.stringify(data)}`)
        const uuidOk = data.clientUuid === TEST_UUID
        const userEntryIdOk = typeof data.userEntryId === 'string' && data.userEntryId.length > 0
        if (uuidOk && userEntryIdOk) {
          r2bStatus = 'PASS'
          r2bDetail = `appendEntry succeeded: clientUuid=${data.clientUuid}, userEntryId=${data.userEntryId}`
          mappedUserEntryId = data.userEntryId
        } else {
          r2bDetail = `mapping entry exists but fields wrong: uuidOk=${uuidOk} userEntryIdOk=${userEntryIdOk}`
        }
      }
    }
    console.log(`${TAG} R2b: ${r2bStatus} — ${r2bDetail}`)

    // ----------------------------------------------------------------
    // R3: 映射指向正确 — mappedUserEntryId 应等于实际 user message entry 的 id
    // ----------------------------------------------------------------
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} R3: mapping points to correct user entry?`)
    let r3Status = 'SKIP'
    let r3Detail = ''
    if (!mappedUserEntryId) {
      r3Detail = 'skipped (R2b failed, no mappedUserEntryId)'
    } else if (allEntries.length === 0) {
      r3Detail = 'skipped (no entries available)'
    } else {
      // 找最后一个 type:"message" + message.role:"user" 的 entry。
      const userEntries = allEntries.filter(
        (e) => e && e.type === 'message' && e.message && e.message.role === 'user',
      )
      if (userEntries.length === 0) {
        r3Status = 'FAIL'
        r3Detail = 'no message entry with role=user found in get_entries result'
      } else {
        const lastUserEntry = userEntries[userEntries.length - 1]
        console.log(`${TAG} R3: last user entry id=${lastUserEntry.id}, mapped userEntryId=${mappedUserEntryId}`)
        if (lastUserEntry.id === mappedUserEntryId) {
          r3Status = 'PASS'
          r3Detail = `mapping points to actual user message entry (id=${lastUserEntry.id})`
        } else {
          r3Status = 'FAIL'
          r3Detail = `id mismatch: mapping.userEntryId=${mappedUserEntryId} but last user entry id=${lastUserEntry.id}`
        }
      }
    }
    console.log(`${TAG} R3: ${r3Status} — ${r3Detail}`)

    return { r1: 'PASS', r2a: r2aStatus, r2b: r2bStatus, r3: r3Status }
  }

  function cleanup() {
    try { child.kill('SIGTERM') } catch (_) {}
    try { rmSync(tmpCwd, { recursive: true, force: true }) } catch (_) {}
  }

  run().then((status) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`${TAG} ============================================================`)
    console.log(`${TAG} SUMMARY: R1 ${status.r1} | R2a ${status.r2a} | R2b ${status.r2b} | R3 ${status.r3}`)
    const isPass = (s) => s === 'PASS'
    const allPass = isPass(status.r1) && isPass(status.r2a) && isPass(status.r2b) && isPass(status.r3)
    if (allPass) {
      console.log(`${TAG} ✅ FULL PASS — input hook + appendEntry + get_entries chain works end-to-end`)
      console.log(`${TAG}    pi 0.80.3 supports the required capabilities. Protocol can proceed.`)
    } else {
      console.log(`${TAG} ❌ FAIL — at least one requirement not met. See details above.`)
      if (!isPass(status.r2b)) {
        console.log(`${TAG}    ⚠️  R2b (appendEntry + get_entries) is the critical gate capability.`)
        console.log(`${TAG}    If pi does not support appendEntry or get_entries does not return`)
        console.log(`${TAG}    custom entries, the mapping framework cannot be built on this approach.`)
      }
    }
    console.log(`${TAG} elapsed: ${elapsed}s`)
    cleanup()
    const code = allPass ? 0 : 1
    setTimeout(() => process.exit(code), 200)
  }).catch((err) => {
    console.error(`${TAG} crashed: ${err && err.stack ? err.stack : err}`)
    cleanup()
    try { child.kill('SIGKILL') } catch (_) {}
    process.exit(2)
  })

  // 全局安全超时 180s。
  setTimeout(() => {
    console.log(`${TAG} global timeout 180s — killing`)
    cleanup()
    setTimeout(() => process.exit(1), 200)
  }, 180000).unref()
}

main()
