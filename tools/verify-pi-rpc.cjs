#!/usr/bin/env node

/**
 * pi RPC 协议验证脚本
 *
 * 验证 pi --mode rpc 的协议格式是否符合 xyz-agent 的适配层预期。
 * 启动 pi 进程 → 发送 prompt 触发工具调用 → 捕获所有事件 → 逐项检查字段格式。
 *
 * 用法: node tools/verify-pi-rpc.cjs [--model provider/modelId]
 */

'use strict'

const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { mkdirSync } = require('node:fs')

// ── Config ──────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'llm-simple-router/glm-5-turbo'
const PROMPT_TEXT = 'run: echo hello'
const CMD_TIMEOUT_MS = 120_000
const EVENT_WAIT_MS = 60_000

// 从命令行参数解析 model
const modelArg = process.argv.find((a, i) => process.argv[i - 1] === '--model') || DEFAULT_MODEL
const MODEL = modelArg

// ── Check tracking ──────────────────────────────────────────────────────

const checks = []

function recordCheck(name, passed, detail) {
  checks.push({ name, passed, detail })
  const icon = passed ? 'PASS' : 'FAIL'
  console.log(`  [${icon}] ${name}${detail ? ': ' + detail : ''}`)
}

// ── State ───────────────────────────────────────────────────────────────

let piProc = null
let msgCounter = 0
const pending = new Map()
let allEvents = []

// ── Utility ─────────────────────────────────────────────────────────────

function nextId() {
  return `verify_${++msgCounter}_${Date.now()}`
}

function sendCommand(type, params = {}) {
  return new Promise((resolve, reject) => {
    if (!piProc || piProc.killed) {
      return reject(new Error('pi process not running'))
    }
    const id = nextId()
    const msg = JSON.stringify({ id, type, ...params }) + '\n'
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Command "${type}" timed out after ${CMD_TIMEOUT_MS}ms`))
    }, CMD_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    piProc.stdin.write(msg)
  })
}

function waitForEvent(eventType, timeoutMs = EVENT_WAIT_MS) {
  return new Promise((resolve, reject) => {
    // 先检查已收集的事件中是否已有匹配
    const found = allEvents.find((e) => e.type === eventType)
    if (found) return resolve(found)

    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event "${eventType}" after ${timeoutMs}ms`))
    }, timeoutMs)

    // 注册一次性检查：每次有新事件时检查
    const checkInterval = setInterval(() => {
      const match = allEvents.find((e) => e.type === eventType && !e._consumed)
      if (match) {
        match._consumed = true
        clearInterval(checkInterval)
        clearTimeout(timer)
        resolve(match)
      }
    }, 100)
  })
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60))
  console.log('pi RPC Protocol Verification')
  console.log(`Model: ${MODEL}`)
  console.log(`Prompt: "${PROMPT_TEXT}"`)
  console.log('='.repeat(60))

  // ── 1. Spawn pi process ────────────────────────────────────────
  console.log('\n[1] Spawning pi process...')

  const providerId = MODEL.split('/')[0]
  const sessionDir = join(homedir(), '.xyz-agent', 'verify-sessions')
  mkdirSync(sessionDir, { recursive: true })

  const args = ['--mode', 'rpc', '--model', MODEL, '--session-dir', sessionDir]

  // 从 xyz-agent 的 config-store 逻辑复制：构建 provider env
  const providerEnv = buildProviderEnv(providerId)

  piProc = spawn('pi', args, {
    cwd: process.cwd(),
    env: { ...process.env, ...providerEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // stdout JSONL 解析
  const rl = createInterface({ input: piProc.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id)
        clearTimeout(entry.timer)
        pending.delete(msg.id)
        entry.resolve(msg)
      } else {
        allEvents.push(msg)
      }
    } catch {
      // 跳过无法解析的行
    }
  })

  // stderr 输出（仅调试用）
  piProc.stderr.on('data', (data) => {
    // 静默处理 stderr，避免干扰检查结果
  })

  // 等待进程启动
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 500)
    piProc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`pi exited immediately with code ${code}`))
    })
    piProc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`pi spawn failed: ${err.message}`))
    })
  })

  console.log('    pi process started successfully')

  // ── 2. Send prompt ─────────────────────────────────────────────
  console.log('\n[2] Sending prompt...')

  let promptResponse
  try {
    promptResponse = await sendCommand('prompt', { message: PROMPT_TEXT })
  } catch (e) {
    console.log(`    Prompt failed: ${e.message}`)
    recordCheck('prompt response has success:true', false, 'command failed or timed out')
    await cleanup()
    printSummary()
    process.exit(1)
  }

  console.log('    Prompt acknowledged')

  // ── 3. Wait for agent_end ──────────────────────────────────────
  console.log('\n[3] Waiting for agent to complete...')
  try {
    await waitForEvent('agent_end')
    console.log('    Agent completed')
  } catch (e) {
    console.log(`    ${e.message}`)
    console.log('    (Continuing with collected events)')
  }

  // 给一点时间让剩余事件到达
  await sleep(500)

  // ── 4. Run checks ──────────────────────────────────────────────
  console.log('\n[4] Running checks...\n')

  // Check 1: prompt response has success:true
  {
    const hasSuccess = promptResponse.success === true
    recordCheck('prompt response has success:true', hasSuccess,
      hasSuccess ? '' : `got: ${JSON.stringify(promptResponse).slice(0, 200)}`)
  }

  // Check 2: message_update events have nested assistantMessageEvent
  {
    const msgUpdates = allEvents.filter((e) => e.type === 'message_update')
    const hasNestedEvent = msgUpdates.length > 0 &&
      msgUpdates.every((e) => e.assistantMessageEvent && typeof e.assistantMessageEvent.type === 'string')
    const subTypes = [...new Set(msgUpdates.map((e) => e.assistantMessageEvent?.type).filter(Boolean))]
    recordCheck('message_update has nested assistantMessageEvent', hasNestedEvent,
      hasNestedEvent ? `sub-types observed: [${subTypes.join(', ')}]` : `got ${msgUpdates.length} message_update events, none had assistantMessageEvent`)
  }

  // Check 3: tool_execution_start has 'args' field
  {
    const toolStarts = allEvents.filter((e) => e.type === 'tool_execution_start')
    if (toolStarts.length === 0) {
      recordCheck('tool_execution_start has "args" field', false, 'no tool_execution_start events captured')
    } else {
      const hasArgs = toolStarts.every((e) => e.args !== undefined)
      const hasOldInput = toolStarts.some((e) => e.args === undefined && e.input !== undefined)
      recordCheck('tool_execution_start has "args" field', hasArgs,
        hasArgs
          ? `all ${toolStarts.length} events have args`
          : `missing args${hasOldInput ? ' (has "input" instead — old format?)' : ''}`)
    }
  }

  // Check 4: tool_execution_end has 'result' field, result is object {content:[...]}
  {
    const toolEnds = allEvents.filter((e) => e.type === 'tool_execution_end')
    if (toolEnds.length === 0) {
      recordCheck('tool_execution_end has "result" field', false, 'no tool_execution_end events captured')
      recordCheck('tool_execution_end result is {content:[...]}', false, 'no tool_execution_end events')
    } else {
      const hasResult = toolEnds.every((e) => e.result !== undefined)
      const hasOldOutput = toolEnds.some((e) => e.result === undefined && e.output !== undefined)
      recordCheck('tool_execution_end has "result" field', hasResult,
        hasResult
          ? `all ${toolEnds.length} events have result`
          : `missing result${hasOldOutput ? ' (has "output" instead — old format?)' : ''}`)

      // 检查 result 的结构
      const resultsWithContent = toolEnds.filter((e) =>
        e.result && typeof e.result === 'object' && Array.isArray(e.result.content))
      const allHaveCorrectShape = toolEnds.length > 0 && resultsWithContent.length === toolEnds.length
      const sampleResult = toolEnds[0]?.result
      recordCheck('tool_execution_end result is {content:[...]}', allHaveCorrectShape,
        allHaveCorrectShape
          ? `all ${toolEnds.length} results have {content:[...]} shape`
          : `sample result: ${JSON.stringify(sampleResult).slice(0, 300)}`)
    }
  }

  // Check 5: get_messages response has 'data' field
  {
    let getMessagesResp
    try {
      getMessagesResp = await sendCommand('get_messages')
    } catch (e) {
      recordCheck('get_messages response has "data" field', false, `command failed: ${e.message}`)
      recordCheck('get_messages data.messages has "toolResult" entries', false, 'get_messages failed')
    }

    if (getMessagesResp) {
      const hasData = getMessagesResp.data !== undefined
      const hasOldPayload = !hasData && getMessagesResp.payload !== undefined
      recordCheck('get_messages response has "data" field', hasData,
        hasData
          ? `data keys: [${Object.keys(getMessagesResp.data).join(', ')}]`
          : `top-level keys: [${Object.keys(getMessagesResp).join(', ')}]${hasOldPayload ? ' (has "payload" instead — old format?)' : ''}`)

      // Check 6: data.messages contains role 'toolResult'
      const messages = getMessagesResp.data?.messages
      if (!messages || !Array.isArray(messages)) {
        recordCheck('get_messages data.messages has "toolResult" entries', false,
          messages ? 'messages is not an array' : 'no data.messages field')
      } else {
        const toolResults = messages.filter((m) => m.role === 'toolResult')
        const hasToolResult = toolResults.length > 0
        const roles = [...new Set(messages.map((m) => m.role))]
        recordCheck('get_messages data.messages has "toolResult" entries', hasToolResult,
          hasToolResult
            ? `found ${toolResults.length} toolResult entries (total messages: ${messages.length})`
            : `roles found: [${roles.join(', ')}]`)
      }
    }
  }

  // ── 5. Cleanup & summary ───────────────────────────────────────
  await cleanup()
  printSummary()

  const allPassed = checks.every((c) => c.passed)
  process.exit(allPassed ? 0 : 1)
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function cleanup() {
  if (!piProc || piProc.killed) return
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      piProc.kill('SIGKILL')
      resolve()
    }, 3000)
    piProc.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    piProc.kill('SIGTERM')
  })
}

function printSummary() {
  console.log('\n' + '='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))

  const passed = checks.filter((c) => c.passed).length
  const failed = checks.filter((c) => !c.passed).length

  for (const check of checks) {
    const icon = check.passed ? 'PASS' : 'FAIL'
    console.log(`  [${icon}] ${check.name}`)
    if (!check.passed && check.detail) {
      console.log(`        ${check.detail}`)
    }
  }

  console.log('─'.repeat(60))
  console.log(`  Total: ${checks.length} | Passed: ${passed} | Failed: ${failed}`)
  console.log('='.repeat(60))

  if (failed > 0) {
    console.log('\n  Captured event types for debugging:')
    const typeCounts = {}
    for (const e of allEvents) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1
    }
    for (const [type, count] of Object.entries(typeCounts)) {
      console.log(`    ${type}: ${count}`)
    }
  }
}

/**
 * 复制 config-store.ts 的 buildProviderEnv 逻辑，
 * 避免在验证脚本中引入 TypeScript 依赖。
 */
function buildProviderEnv(providerId) {
  try {
    const { readFileSync, existsSync } = require('node:fs')
    const { join } = require('node:path')
    const { homedir } = require('node:os')

    // 优先从 xyz-agent config 读取
    const xyzConfigPath = join(homedir(), '.xyz-agent', 'config.json')
    let providers = null
    if (existsSync(xyzConfigPath)) {
      const raw = readFileSync(xyzConfigPath, 'utf-8')
      const parsed = JSON.parse(raw)
      providers = parsed.providers
    }

    // 回退到 pi config
    if (!providers) {
      const piConfigPath = join(homedir(), '.pi', 'config.json')
      if (existsSync(piConfigPath)) {
        const raw = readFileSync(piConfigPath, 'utf-8')
        const parsed = JSON.parse(raw)
        providers = parsed.providers
      }
    }

    if (!providers || !providers[providerId]) return {}

    const provider = providers[providerId]
    const envPrefix = providerId.toUpperCase().replace(/-/g, '_')
    const env = {}
    if (provider.apiKey) env[`${envPrefix}_API_KEY`] = provider.apiKey
    if (provider.baseUrl) env[`${envPrefix}_BASE_URL`] = provider.baseUrl
    return env
  } catch {
    return {}
  }
}

// ── Process cleanup on unhandled errors ─────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\nInterrupted, cleaning up...')
  await cleanup()
  process.exit(1)
})

process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err)
  await cleanup()
  process.exit(1)
})

main().catch(async (err) => {
  console.error('Fatal error:', err)
  await cleanup()
  process.exit(1)
})
