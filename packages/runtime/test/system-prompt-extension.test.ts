/**
 * xyz-system-prompt-extension.js 单测（TDD 红灯）。
 *
 * 动态 import repo root 的插件文件，验证 before_agent_start hook 行为：
 * - append 开启且 prompt 非空 → 追加到 event.systemPrompt
 * - append 关闭 / 配置缺失 / 配置损坏 / append.prompt 空白 → 返回 undefined
 * - 支持 XYZ_AGENT_DATA_DIR 与 PI_CODING_AGENT_DIR 回退两种目录解析
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface SystemPromptConfig {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
}

const PLUGIN_PATH = new URL('../../../xyz-system-prompt-extension.js', import.meta.url).pathname

function writeConfig(dataDir: string, config: SystemPromptConfig): void {
  writeFileSync(join(dataDir, 'system-prompt.json'), JSON.stringify(config), 'utf-8')
}

let tmpDir: string
let dataDir: string
let piAgentDir: string
let originalDataDir: string | undefined
let originalPiAgentDir: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'system-prompt-ext-'))
  dataDir = tmpDir
  piAgentDir = join(tmpDir, 'pi', 'agent')
  mkdirSync(piAgentDir, { recursive: true })
  originalDataDir = process.env.XYZ_AGENT_DATA_DIR
  originalPiAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.XYZ_AGENT_DATA_DIR = dataDir
  delete process.env.PI_CODING_AGENT_DIR
})

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.XYZ_AGENT_DATA_DIR
  } else {
    process.env.XYZ_AGENT_DATA_DIR = originalDataDir
  }
  if (originalPiAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR
  } else {
    process.env.PI_CODING_AGENT_DIR = originalPiAgentDir
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

async function loadPlugin() {
  const mod = await import(PLUGIN_PATH) as unknown as { default?: (pi: unknown) => void }
  return mod.default
}

type PiLike = { on: ReturnType<typeof vi.fn> }
type Handler = (event: { systemPrompt: string }) => { systemPrompt?: string } | undefined

function installPlugin(factory: (pi: unknown) => void): { pi: PiLike; handler: Handler } {
  const pi: PiLike = { on: vi.fn() }
  factory(pi)
  const call = pi.on.mock.calls.find(([name]: [string]) => name === 'before_agent_start')
  expect(call).toBeDefined()
  return { pi, handler: call![1] as Handler }
}

describe('xyz-system-prompt-extension', () => {
  it('append 开启且非空 → 返回 BASE + "\\n\\n" + EXTRA', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'EXTRA' },
    })
    const { handler } = installPlugin(factory)

    const result = handler({ systemPrompt: 'BASE' })
    expect(result).toEqual({ systemPrompt: 'BASE\n\nEXTRA' })
  })

  it('append 关闭 → 返回 undefined', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: 'ignored' },
    })
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('配置文件缺失 → 返回 undefined', async () => {
    const factory = await loadPlugin()
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('配置文件 JSON 损坏 → 返回 undefined', async () => {
    const factory = await loadPlugin()
    writeFileSync(join(dataDir, 'system-prompt.json'), '{ not json', 'utf-8')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('append.prompt 纯空白 → 返回 undefined', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: '   \t\n  ' },
    })
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('未设 XYZ_AGENT_DATA_DIR 时可用 PI_CODING_AGENT_DIR 回退定位配置', async () => {
    delete process.env.XYZ_AGENT_DATA_DIR
    process.env.PI_CODING_AGENT_DIR = piAgentDir

    const factory = await loadPlugin()
    // PI_CODING_AGENT_DIR/../.. === tmpDir === dataDir
    writeConfig(tmpDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'FALLBACK' },
    })
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({ systemPrompt: 'BASE\n\nFALLBACK' })
  })
})
