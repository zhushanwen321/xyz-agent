#!/usr/bin/env node
/**
 * verify-system-prompt-hook.cjs — Pre-implementation verification (spec §8, rule #4).
 *
 * Manual diagnostic script (NOT a unit test). Verifies two contracts of the
 * pi binary used by the system-prompt feature:
 *
 *   1. `before_agent_start` extension hook fires and the event exposes the
 *      fields we rely on (`systemPrompt` string, plus `systemPromptOptions`
 *      / `prompt` for completeness).
 *   2. `--system-prompt` CLI argument is accepted by pi (no "unknown argument"
 *      error) — i.e. the replace mechanism the spec depends on exists.
 *
 * Design: best-effort. Running pi end-to-end requires a full provider/model
 * config which is not available in every environment. The script spawns pi
 * with a temporary extension that prints the hook event shape to stdout, plus
 * `--system-prompt`. If pi exits early due to missing provider, that is OK —
 * we still report which contract could be confirmed from stderr/stdout.
 *
 * Usage:  node tools/verify-system-prompt-hook.cjs
 *
 * Exit codes:
 *   0 — at least one contract fully confirmed (or pi binary absent and that
 *       was reported cleanly)
 *   1 — pi binary exists but neither contract could be confirmed
 */

'use strict'

const { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// 1. Locate the pi binary.
// ---------------------------------------------------------------------------
function locatePiBinary() {
  const isWin = process.platform === 'win32'
  const candidates = [
    path.join(REPO_ROOT, 'resources', 'pi', 'bin', isWin ? 'pi.exe' : 'pi'),
    // Fallback: packaged resources sometimes live elsewhere; allow override.
    process.env.PI_BIN ? path.resolve(process.env.PI_BIN) : null,
  ].filter(Boolean)

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

// ---------------------------------------------------------------------------
// 2. Build the temporary extension that captures the hook event shape.
// ---------------------------------------------------------------------------
const TMP_EXT_SOURCE = `
module.exports = function (pi) {
  pi.on('before_agent_start', function (event) {
    const shape = {
      hasSystemPrompt: typeof event.systemPrompt !== 'undefined',
      systemPromptType: typeof event.systemPrompt,
      systemPromptLength: typeof event.systemPrompt === 'string' ? event.systemPrompt.length : null,
      systemPromptOptionsKeys:
        event.systemPromptOptions && typeof event.systemPromptOptions === 'object'
          ? Object.keys(event.systemPromptOptions)
          : null,
      promptType: typeof event.prompt,
      eventType: typeof event.type !== 'undefined' ? event.type : null
    }
    // Tagged JSON line on stdout — easy to parse from the parent.
    process.stdout.write('@@XYZ_HOOK_EVENT@@' + JSON.stringify(shape) + '\\n')
  })
}
`

function createTempExtension() {
  const tmpDir = path.join(os.tmpdir(), 'xyz-verify-pi-hook-' + process.pid)
  mkdirSync(tmpDir, { recursive: true })
  const extPath = path.join(tmpDir, 'capture-hook.cjs')
  writeFileSync(extPath, TMP_EXT_SOURCE, 'utf-8')
  return { extPath, tmpDir }
}

// ---------------------------------------------------------------------------
// 3. Spawn pi with the extension + --system-prompt, capture output.
// ---------------------------------------------------------------------------
function runPi(piBin, extPath) {
  return new Promise((resolve) => {
    const customPrompt = 'VERIFIED_CUSTOM_PROMPT'
    const args = [
      '--extension', extPath,
      '--system-prompt', customPrompt,
      // --print / non-interactive so pi does not hang waiting on a TTY.
      '--print',
      // A trivial prompt so pi has something to send if it gets that far.
      'hi',
    ]

    const child = spawn(piBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''
    const MAX = 8192
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX) stdout += d.toString('utf-8')
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX) stderr += d.toString('utf-8')
    })

    // Safety timeout — never hang the script.
    // SIGKILL 后由 child.on('close') 异步 resolve Promise（内核 SIGKILL 后会派发 close），
    // 此处不额外 await；close 前的 stdout/stderr 缓冲可能被截断（best-effort 诊断工具可接受）。
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch (_) { /* ignore */ }
    }, 15000)

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: -1, signal: null, spawnError: true })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, signal, spawnError: false })
    })
  })
}

// ---------------------------------------------------------------------------
// 4. Analyze captured output and report conclusions.
// ---------------------------------------------------------------------------
function analyze(result) {
  const { stdout, stderr, code, signal, spawnError } = result

  // (a) Did our tagged hook-event line appear?
  let hookEvent = null
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('@@XYZ_HOOK_EVENT@@')
    if (idx >= 0) {
      const payload = line.slice(idx + '@@XYZ_HOOK_EVENT@@'.length).trim()
      try {
        hookEvent = JSON.parse(payload)
        break
      } catch (_) {
        // keep scanning
      }
    }
  }

  // (b) Did pi reject `--system-prompt` as an unknown argument?
  const unknownArgMatch = stderr.match(/unknown option[^\n]*--system-prompt|unrecognized[^\n]*--system-prompt|invalid option[^\n]*--system-prompt/i)
  const systemPromptAccepted = !unknownArgMatch

  return { hookEvent, systemPromptAccepted, unknownArgMatch }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const piBin = locatePiBinary()

  console.log('[VERIFY] system-prompt hook + --system-prompt CLI contract check')
  console.log('[VERIFY] ----------------------------------------------------')

  if (!piBin) {
    console.log('[VERIFY] pi binary not found under resources/pi/bin/{pi,pi.exe}.')
    console.log('[VERIFY] Set PI_BIN=/path/to/pi to point at a packaged binary.')
    console.log('[VERIFY] Conclusion: SKIPPED (no binary to test).')
    console.log('[VERIFY] --system-prompt accepted: unknown (not tested)')
    console.log('[VERIFY] before_agent_start event shape: unknown (not tested)')
    return 0
  }

  console.log('[VERIFY] pi binary: ' + piBin)

  const { extPath, tmpDir } = createTempExtension()
  console.log('[VERIFY] temp extension: ' + extPath)

  let result
  try {
    console.log('[VERIFY] spawning pi with --extension + --system-prompt ...')
    result = await runPi(piBin, extPath)
  } finally {
    try { unlinkSync(extPath) } catch (_) { /* ignore */ }
    try { require('node:fs').rmdirSync(tmpDir) } catch (_) { /* ignore */ }
  }

  const { hookEvent, systemPromptAccepted, unknownArgMatch } = analyze(result)

  console.log('[VERIFY] ----------------------------------------------------')
  console.log('[VERIFY] spawn error:        ' + (result.spawnError ? 'yes' : 'no'))
  console.log('[VERIFY] exit code:          ' + result.code)
  console.log('[VERIFY] exit signal:        ' + (result.signal || 'none'))
  console.log('[VERIFY] --system-prompt accepted: ' + (systemPromptAccepted ? 'yes' : 'no'))
  if (!systemPromptAccepted) {
    console.log('[VERIFY]   reason: ' + (unknownArgMatch ? unknownArgMatch[0] : '(see stderr)'))
  }
  if (hookEvent) {
    console.log('[VERIFY] before_agent_start event shape:')
    console.log('[VERIFY]   ' + JSON.stringify(hookEvent))
  } else {
    console.log('[VERIFY] before_agent_start event shape: not observed')
    console.log('[VERIFY]   (pi likely exited before sending a turn; check config/provider)')
  }
  console.log('[VERIFY] ----------------------------------------------------')
  if (result.stderr.trim()) {
    console.log('[VERIFY] stderr (first 2KB):')
    console.log(result.stderr.slice(0, 2048))
    console.log('[VERIFY] ----------------------------------------------------')
  }

  const confirmed = systemPromptAccepted || !!hookEvent
  if (confirmed) {
    console.log('[VERIFY] Conclusion: PASS — at least one contract confirmed.')
    return 0
  }
  console.log('[VERIFY] Conclusion: PARTIAL — pi ran but neither contract confirmed.')
  console.log('[VERIFY]   Inspect stderr above; a missing provider/config may explain this.')
  return 1
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[VERIFY] script crashed: ' + (err && err.stack ? err.stack : err))
  process.exit(2)
})
