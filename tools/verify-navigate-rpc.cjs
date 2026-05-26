#!/usr/bin/env node

/**
 * pi RPC Tree Navigation 验证脚本
 *
 * 连接运行中的 pi 进程，验证 session tree 相关的 RPC 能力：
 * 1. get_commands — 检查是否有 tree 相关命令/extension
 * 2. get_state — 获取当前 session 信息
 * 3. 发送 navigate 相关命令，监听事件结构
 *
 * 用法: node tools/verify-navigate-rpc.cjs
 *
 * 注意: 需要一个运行中的 pi 进程（--mode rpc）。脚本会启动 pi 子进程。
 */

'use strict'

const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { mkdirSync } = require('node:fs')

// ── Config ──────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'llm-simple-router/glm-5-turbo'
const CMD_TIMEOUT_MS = 30_000

const modelArg = process.argv.find((a, i) => process.argv[i - 1] === '--model') || DEFAULT_MODEL
const MODEL = modelArg

// ── State ───────────────────────────────────────────────────────────────

let piProc = null
let msgCounter = 0
const pending = new Map()
let allEvents = []
const checks = []

// ── Utility ─────────────────────────────────────────────────────────────

function nextId() {
  return `nav_verify_${++msgCounter}_${Date.now()}`
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function recordCheck(name, passed, detail) {
  checks.push({ name, passed, detail })
  const icon = passed ? 'PASS' : 'FAIL'
  console.log(`  [${icon}] ${name}${detail ? ': ' + detail : ''}`)
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60))
  console.log('pi RPC Tree Navigation Verification')
  console.log(`Model: ${MODEL}`)
  console.log('='.repeat(60))

  // ── 1. Spawn pi ────────────────────────────────────────────────
  console.log('\n[1] Spawning pi process...')

  const sessionDir = join(homedir(), '.xyz-agent', 'verify-nav-sessions')
  mkdirSync(sessionDir, { recursive: true })

  piProc = spawn('pi', ['--mode', 'rpc', '--model', MODEL, '--session-dir', sessionDir], {
    cwd: process.cwd(),
    env: buildProviderEnv(MODEL.split('/')[0]),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

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
      // Skip non-JSON lines
    }
  })

  piProc.stderr.on('data', () => {
    // Silenced
  })

  // Wait for startup
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 800)
    piProc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`pi exited immediately with code ${code}`))
    })
    piProc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`pi spawn failed: ${err.message}`))
    })
  })

  console.log('    pi process started')

  // ── 2. get_state — check session info ──────────────────────────
  console.log('\n[2] Getting session state...')
  let state
  try {
    state = await sendCommand('get_state')
  } catch (e) {
    console.log(`    get_state failed: ${e.message}`)
    console.log('\n    Cannot proceed — pi may not support RPC mode or crashed.')
    await cleanup()
    process.exit(1)
  }

  const hasSessionFile = !!state.data?.sessionFile
  recordCheck('get_state returns sessionFile', hasSessionFile,
    hasSessionFile ? state.data.sessionFile : `data keys: ${Object.keys(state.data || {}).join(', ')}`)

  if (hasSessionFile) {
    console.log(`    sessionFile: ${state.data.sessionFile}`)
    console.log(`    sessionId: ${state.data.sessionId || 'N/A'}`)
  }

  // ── 3. get_commands — check for tree-related extensions ────────
  console.log('\n[3] Checking available commands...')
  let commandsResp
  try {
    commandsResp = await sendCommand('get_commands')
  } catch (e) {
    recordCheck('get_commands succeeds', false, e.message)
    await cleanup()
    printSummary()
    process.exit(1)
  }

  const commands = commandsResp.data?.commands || []
  const commandNames = commands.map((c) => c.name)

  console.log(`    Available commands (${commands.length}):`)
  for (const cmd of commands) {
    console.log(`      - ${cmd.name} [${cmd.source}] ${cmd.description || ''}`)
  }

  // Check for navigate-related commands
  const hasNavigate = commandNames.some((n) => n.includes('navigate'))
  const hasTree = commandNames.some((n) => n.includes('tree'))
  recordCheck('Tree/navigate commands available', hasNavigate || hasTree,
    hasNavigate || hasTree
      ? `Found: ${commandNames.filter((n) => n.includes('navigate') || n.includes('tree')).join(', ')}`
      : 'No navigate/tree commands found in extensions')

  // ── 4. get_messages — inspect message structure ────────────────
  console.log('\n[4] Getting messages to inspect tree structure...')
  let messagesResp
  try {
    messagesResp = await sendCommand('get_messages')
  } catch (e) {
    recordCheck('get_messages succeeds', false, e.message)
    await cleanup()
    printSummary()
    process.exit(1)
  }

  const messages = messagesResp.data?.messages || []
  console.log(`    Message count: ${messages.length}`)

  if (messages.length > 0) {
    const roles = [...new Set(messages.map((m) => m.role))]
    console.log(`    Roles: [${roles.join(', ')}]`)

    // Show first few messages with IDs if available
    console.log('    First messages:')
    for (let i = 0; i < Math.min(5, messages.length); i++) {
      const m = messages[i]
      const textPreview = extractMessageText(m).slice(0, 80)
      console.log(`      [${i}] role=${m.role} text="${textPreview}"`)
    }
  }

  recordCheck('get_messages returns messages', messages.length > 0,
    `${messages.length} messages found`)

  // ── 5. Send a prompt and observe events ────────────────────────
  console.log('\n[5] Sending test prompt to trigger events...')
  try {
    await sendCommand('prompt', { message: 'echo "verify-navigate-rpc"' })
    console.log('    Prompt sent, waiting for events...')

    // Wait for agent to finish
    const agentEnd = waitForEvent('agent_end', 60_000)
    try {
      await agentEnd
      console.log('    Agent completed')
    } catch {
      console.log('    Timeout waiting for agent_end, continuing with collected events')
    }

    await sleep(500)
  } catch (e) {
    console.log(`    Prompt failed: ${e.message}`)
  }

  // ── 6. Analyze collected events ────────────────────────────────
  console.log('\n[6] Analyzing event structure...\n')

  // Event type summary
  const typeCounts = {}
  for (const e of allEvents) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1
  }
  console.log('    Event types observed:')
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`      ${type}: ${count}`)
  }

  // Check for session_tree event
  const treeEvents = allEvents.filter((e) => e.type === 'session_tree')
  recordCheck('session_tree event received', treeEvents.length > 0,
    treeEvents.length > 0
      ? `Fields: ${Object.keys(treeEvents[0]).join(', ')}`
      : 'No session_tree event (may not be triggered by this prompt)')

  // Check message_start/message_end structure
  const msgStarts = allEvents.filter((e) => e.type === 'message_start')
  const msgEnds = allEvents.filter((e) => e.type === 'message_end')
  recordCheck('message_start/end events present',
    msgStarts.length > 0 && msgEnds.length > 0,
    `starts: ${msgStarts.length}, ends: ${msgEnds.length}`)

  // ── 7. Try fork command ─────────────────────────────────────────
  console.log('\n[7] Testing fork capability...')
  try {
    // Need an entry ID to fork from — use the first user message if available
    const firstUserMsg = messages.find((m) => m.role === 'user')
    if (firstUserMsg) {
      // The messages from get_messages may not have entry IDs directly.
      // Try get_fork_messages instead which returns entryId + text.
      const forkMsgsResp = await sendCommand('get_fork_messages')
      const forkMessages = forkMsgsResp.data?.messages || []
      recordCheck('get_fork_messages succeeds', forkMsgsResp.success === true,
        `Returned ${forkMessages.length} forkable messages`)

      if (forkMessages.length > 0) {
        console.log(`    Fork messages: ${forkMessages.length} entries`)
        for (const fm of forkMessages.slice(0, 3)) {
          console.log(`      entryId=${fm.entryId} text="${(fm.text || '').slice(0, 60)}"`)
        }

        // Don't actually fork — just report that the API is available
        recordCheck('Fork entries have entryId', forkMessages.every((m) => m.entryId),
          `All ${forkMessages.length} entries have entryId`)
      }
    } else {
      recordCheck('get_fork_messages test', false, 'No user messages to fork from')
    }
  } catch (e) {
    recordCheck('fork command test', false, e.message)
  }

  // ── Summary ────────────────────────────────────────────────────
  await cleanup()
  printSummary()

  const allPassed = checks.every((c) => c.passed)
  process.exit(allPassed ? 0 : 1)
}

// ── Helpers ─────────────────────────────────────────────────────────────

function waitForEvent(eventType, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const found = allEvents.find((e) => e.type === eventType)
    if (found) return resolve(found)

    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for "${eventType}" after ${timeoutMs}ms`))
    }, timeoutMs)

    const interval = setInterval(() => {
      const match = allEvents.find((e) => e.type === eventType && !e._consumed)
      if (match) {
        match._consumed = true
        clearInterval(interval)
        clearTimeout(timer)
        resolve(match)
      }
    }, 100)
  })
}

function extractMessageText(msg) {
  if (!msg.content) return ''
  if (typeof msg.content === 'string') return msg.content
  if (!Array.isArray(msg.content)) return ''
  for (const block of msg.content) {
    if (block.type === 'text' && block.text) return block.text
  }
  return ''
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

  console.log('-'.repeat(60))
  console.log(`  Total: ${checks.length} | Passed: ${passed} | Failed: ${failed}`)
  console.log('='.repeat(60))
}

function buildProviderEnv(providerId) {
  try {
    const { readFileSync, existsSync } = require('node:fs')
    const { join } = require('node:path')
    const { homedir } = require('node:os')

    const xyzConfigPath = join(homedir(), '.xyz-agent', 'config.json')
    let providers = null
    if (existsSync(xyzConfigPath)) {
      const raw = readFileSync(xyzConfigPath, 'utf-8')
      providers = JSON.parse(raw).providers
    }

    if (!providers) {
      const piConfigPath = join(homedir(), '.pi', 'config.json')
      if (existsSync(piConfigPath)) {
        const raw = readFileSync(piConfigPath, 'utf-8')
        providers = JSON.parse(raw).providers
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

// ── Process cleanup ─────────────────────────────────────────────────────

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
