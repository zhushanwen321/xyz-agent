import { describe, it, expect } from 'vitest'
import {
  BUILTIN_TOOLS,
  BUILTIN_EXTENSION_FILES,
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  type PiLaunchPreset,
  type ToolMode,
  type ExtensionMode,
  type ThinkingLevel,
} from '../pi-preset'

describe('pi-preset 常量', () => {
  it('BUILTIN_TOOLS 含 pi 的 7 个内置工具', () => {
    expect(BUILTIN_TOOLS.length).toBe(7)
    expect([...BUILTIN_TOOLS]).toEqual(['read', 'write', 'bash', 'edit', 'grep', 'find', 'ls'])
  })

  it('BUILTIN_EXTENSION_FILES 含 3 个 builtin 文件名', () => {
    expect(BUILTIN_EXTENSION_FILES.length).toBe(3)
    expect([...BUILTIN_EXTENSION_FILES]).toEqual([
      'xyz-agent-extension.js',
      'xyz-system-prompt-extension.js',
      'xyz-client-msg-id-mapper.js',
    ])
  })

  it('BUILTIN_PRESET_IDS 映射正确', () => {
    expect(BUILTIN_PRESET_IDS.FULL).toBe('builtin:full')
    expect(BUILTIN_PRESET_IDS.ORCHESTRATOR).toBe('builtin:orchestrator')
    expect(BUILTIN_PRESET_IDS.READONLY).toBe('builtin:readonly')
  })
})

describe('DEFAULT_PRESETS', () => {
  it('含 3 个内置预设', () => {
    expect(DEFAULT_PRESETS.length).toBe(3)
  })

  it('所有预设 builtin=true 且 order 不重复', () => {
    expect(DEFAULT_PRESETS.every(p => p.builtin === true)).toBe(true)
    const orders = DEFAULT_PRESETS.map(p => p.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('FULL 预设 toolMode=all/extensionMode=all', () => {
    const full = DEFAULT_PRESETS.find(p => p.id === 'builtin:full')!
    expect(full.toolMode).toBe('all')
    expect(full.extensionMode).toBe('all')
  })

  it('ORCHESTRATOR 预设 denylist 排除 read/write/bash/edit', () => {
    const orch = DEFAULT_PRESETS.find(p => p.id === 'builtin:orchestrator')!
    expect(orch.toolMode).toBe('denylist')
    expect(orch.deniedTools).toEqual(['read', 'write', 'bash', 'edit'])
  })

  it('READONLY 预设 allowlist 只读工具', () => {
    const ro = DEFAULT_PRESETS.find(p => p.id === 'builtin:readonly')!
    expect(ro.toolMode).toBe('allowlist')
    expect(ro.allowedTools).toEqual(['read', 'grep', 'find', 'ls'])
  })
})

// 编译时类型检查（TC-W1-1）：可选字段可省略
const _minimalPreset: PiLaunchPreset = {
  id: 'test',
  name: 'test',
  builtin: false,
  order: 0,
  toolMode: 'all',
  extensionMode: 'all',
}
// 编译时类型检查（TC-W1-2/3）：联合类型字面量约束
const _tm: ToolMode = 'all'
const _em: ExtensionMode = 'denylist'
const _tl: ThinkingLevel = 'high'
