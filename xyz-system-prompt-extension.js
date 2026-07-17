/**
 * xyz-system-prompt-extension.js — pi file-type extension.
 *
 * Registers a `before_agent_start` hook that:
 *  1. Reads <dataDir>/system-prompt.json every turn (never cached).
 *  2. When `append.enabled === true` and `append.prompt` is non-blank,
 *     appends the user's text to the event's systemPrompt.
 *
 * Fail-safe: any error in the handler is swallowed and `undefined` is returned
 * so the agent loop is never blocked.
 *
 * The factory is symmetric with `xyz-agent-extension.js` (single file, no
 * build step, no npm deps). pi loads it via `--extension <path>` at spawn.
 */

import path from 'node:path'
import { readFileSync } from 'node:fs'

const CONFIG_FILE = 'system-prompt.json'

/**
 * Resolve the data directory from the environment.
 *
 * Priority:
 *  1. `process.env.XYZ_AGENT_DATA_DIR` (explicit)
 *  2. `path.resolve(process.env.PI_CODING_AGENT_DIR ?? '', '..', '..')`
 *     (PI_CODING_AGENT_DIR == <dataDir>/pi/agent, two levels up == dataDir)
 *
 * Re-read on every handler invocation so env changes between turns/sessions
 * take effect without reloading the extension.
 */
function resolveDataDir() {
  if (process.env.XYZ_AGENT_DATA_DIR) {
    return process.env.XYZ_AGENT_DATA_DIR
  }
  return path.resolve(process.env.PI_CODING_AGENT_DIR ?? '', '..', '..')
}

/**
 * Read & parse the config file. Missing / malformed / partial → all-default.
 * Returns the effective config object; never throws.
 */
function readConfig(dataDir) {
  const defaults = {
    version: 1,
    replace: { enabled: false, prompt: '' },
    append: { enabled: false, prompt: '' },
  }
  const cfgPath = path.join(dataDir, CONFIG_FILE)
  let raw
  try {
    raw = readFileSync(cfgPath, 'utf-8')
  } catch {
    return defaults
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaults
  }
  if (!parsed || typeof parsed !== 'object') {
    return defaults
  }
  // Merge defensively — every field has its own default.
  const replaceRaw = parsed.replace && typeof parsed.replace === 'object' ? parsed.replace : {}
  const appendRaw = parsed.append && typeof parsed.append === 'object' ? parsed.append : {}
  return {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    replace: {
      enabled: replaceRaw.enabled === true,
      prompt: typeof replaceRaw.prompt === 'string' ? replaceRaw.prompt : '',
    },
    append: {
      enabled: appendRaw.enabled === true,
      prompt: typeof appendRaw.prompt === 'string' ? appendRaw.prompt : '',
    },
  }
}

export default function (pi) {
  pi.on('before_agent_start', (event) => {
    try {
      const dataDir = resolveDataDir()
      const cfg = readConfig(dataDir)

      const basePrompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : ''
      let newPrompt = basePrompt

      if (cfg.append.enabled && cfg.append.prompt.trim()) {
        newPrompt = basePrompt + '\n\n' + cfg.append.prompt
      }

      return newPrompt === event.systemPrompt ? undefined : { systemPrompt: newPrompt }
    } catch {
      // Never block the agent loop.
      return undefined
    }
  })
}
