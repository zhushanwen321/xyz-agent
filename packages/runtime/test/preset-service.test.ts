/**
 * PresetService 单测（wave 1: 存储内核 + CRUD）。
 *
 * 覆盖 10 个 testCase：
 *   - 读路径（getAllPresets 默认/合并/getPreset 找不到）
 *   - 写路径（savePreset builtin 保护 / savePreset 自定义 / deletePreset builtin / deletePreset 自定义）
 *   - default 读写
 *   - IO 容错（JSON 畸形兜底）
 *   - builtin:false 逃逸保护
 *
 * mock 策略：fake ConfigStore（getConfigDir 返回 tmpdir）+ fake ExtensionService（vi.fn 占位，本 wave 不调用）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_PRESETS,
  BUILTIN_PRESET_IDS,
  type PiLaunchPreset,
  type PiPresetsFile,
} from '@xyz-agent/shared'
import { PresetService, PresetGuardError } from '../src/services/preset-service.js'

/** 只暴露 getConfigDir 的最小 fake configStore。 */
function makeFakeConfigStore(configDir: string) {
  return { getConfigDir: () => configDir }
}

/** 占位 fake extensionService（本 wave 不调用，wave2 改 resolve 时再补真实 mock 返回值）。 */
function makeFakeExtensionStore() {
  return {
    getBuiltinExtensionPaths: vi.fn(() => []),
    scanExtensions: vi.fn(async () => []),
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(async () => []),
  }
}

let tmpDir: string
let presetService: PresetService

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'preset-service-test-'))
  const configStore = makeFakeConfigStore(tmpDir)
  const extensionStore = makeFakeExtensionStore()
  presetService = new PresetService(
    configStore as unknown as ConstructorParameters<typeof PresetService>[0],
    extensionStore as unknown as ConstructorParameters<typeof PresetService>[1],
  )
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function piPresetsPath(): string {
  return join(tmpDir, 'pi-presets.json')
}

function writeFile(file: PiPresetsFile): void {
  writeFileSync(piPresetsPath(), JSON.stringify(file, null, 2), 'utf-8')
}

function readFile(): PiPresetsFile | undefined {
  if (!existsSync(piPresetsPath())) return undefined
  return JSON.parse(readFileSync(piPresetsPath(), 'utf-8')) as PiPresetsFile
}

describe('PresetService · wave 1 存储内核', () => {
  // ── 读路径 ──────────────────────────────────────────────────

  it('w1-tc1: getAllPresets 用户文件不存在时返回 DEFAULT_PRESETS', () => {
    expect(existsSync(piPresetsPath())).toBe(false)
    const all = presetService.getAllPresets()
    expect(all).toHaveLength(DEFAULT_PRESETS.length)
    expect(all.map(p => p.id)).toEqual(DEFAULT_PRESETS.map(p => p.id))
    // 按 order 升序
    expect(all.map(p => p.order)).toEqual([...DEFAULT_PRESETS].map(p => p.order).sort((a, b) => a - b))
  })

  it('w1-tc2: getAllPresets 用户覆盖 builtin 字段按 id 合并 + 自定义追加', () => {
    const file: PiPresetsFile = {
      version: 1,
      defaultPresetId: BUILTIN_PRESET_IDS.FULL,
      presets: [
        // 覆盖 builtin:full 的 description
        {
          ...DEFAULT_PRESETS[0]!,
          id: BUILTIN_PRESET_IDS.FULL,
          name: '全工具模式',
          builtin: true,
          order: 0,
          description: '我被用户改了',
        },
        // 一个自定义
        {
          id: 'uuid-custom-1',
          name: '我的预设',
          builtin: false,
          order: 10,
          toolMode: 'all',
          extensionMode: 'all',
        },
      ],
    }
    writeFile(file)

    const all = presetService.getAllPresets()
    // 3 个 DEFAULT + 1 个自定义
    expect(all).toHaveLength(4)
    const full = all.find(p => p.id === BUILTIN_PRESET_IDS.FULL)!
    expect(full.description).toBe('我被用户改了')
    expect(full.toolMode).toBe('all') // 来自 DEFAULT 兜底（用户未传则保留 DEFAULT 值）
    const custom = all.find(p => p.id === 'uuid-custom-1')
    expect(custom).toBeDefined()
    expect(custom!.builtin).toBe(false)
    // 按 order 升序：0(full), 1(orch), 2(ro), 10(custom)
    expect(all.map(p => p.order)).toEqual([0, 1, 2, 10])
  })

  it('w1-tc9: getPreset 找不到返回 undefined，builtin:full 总能找到', () => {
    expect(presetService.getPreset('nope')).toBeUndefined()
    const full = presetService.getPreset(BUILTIN_PRESET_IDS.FULL)
    expect(full).toBeDefined()
    expect(full!.id).toBe(BUILTIN_PRESET_IDS.FULL)
  })

  // ── 写路径 ──────────────────────────────────────────────────

  it('w1-tc3: savePreset 对 builtin preset 保护 id/builtin/order/name', () => {
    presetService.savePreset({
      id: BUILTIN_PRESET_IDS.FULL,
      name: 'hacked', // 应被忽略（保留 DEFAULT '全工具模式'）
      builtin: true,
      order: 99, // 应被忽略（保留 DEFAULT 0）
      toolMode: 'allowlist',
      allowedTools: ['read'],
      extensionMode: 'all',
    })

    const full = presetService.getPreset(BUILTIN_PRESET_IDS.FULL)!
    expect(full.name).toBe('全工具模式') // 保护
    expect(full.order).toBe(0) // 保护
    expect(full.builtin).toBe(true)
    expect(full.toolMode).toBe('allowlist') // 用户值生效
    expect(full.allowedTools).toEqual(['read'])
  })

  it('w1-tc4: savePreset 传 builtin id 但 builtin:false 抛 PresetGuardError', () => {
    expect(() => {
      presetService.savePreset({
        id: BUILTIN_PRESET_IDS.FULL,
        name: 'x',
        builtin: false, // 试图降级逃逸
        order: 0,
        toolMode: 'all',
        extensionMode: 'all',
      })
    }).toThrow(PresetGuardError)

    // 文件未写入（savePreset 在校验阶段就抛错）
    // 直接读 pi-presets.json 应不存在或不含该篡改项
    const onDisk = readFile()
    expect(onDisk?.presets ?? []).toEqual([])
  })

  it('w1-tc5: deletePreset 内置 preset 抛 PresetGuardError，文件不变', () => {
    // 先写一个合法 pi-presets.json
    writeFile({
      version: 1,
      presets: [
        { ...DEFAULT_PRESETS[0]!, description: 'preset' },
      ],
    })

    expect(() => {
      presetService.deletePreset(BUILTIN_PRESET_IDS.FULL)
    }).toThrow(PresetGuardError)

    // 文件未变更
    const onDisk = readFile()
    expect(onDisk!.presets).toHaveLength(1)
  })

  it('w1-tc6: deletePreset 自定义 preset 从文件移除', () => {
    writeFile({
      version: 1,
      presets: [
        { id: 'uuid-del', name: 'a', builtin: false, order: 5, toolMode: 'all', extensionMode: 'all' },
        { id: 'uuid-keep', name: 'b', builtin: false, order: 6, toolMode: 'all', extensionMode: 'all' },
      ],
    })

    presetService.deletePreset('uuid-del')

    const all = presetService.getAllPresets()
    expect(all.find(p => p.id === 'uuid-del')).toBeUndefined()
    expect(all.find(p => p.id === 'uuid-keep')).toBeDefined()
  })

  it('w1-tc7: getDefaultPresetId 空文件兜底 builtin:full，setDefault 后读回新值', () => {
    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.FULL)

    presetService.setDefaultPresetId(BUILTIN_PRESET_IDS.ORCHESTRATOR)

    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.ORCHESTRATOR)
    const onDisk = readFile()
    expect(onDisk!.defaultPresetId).toBe(BUILTIN_PRESET_IDS.ORCHESTRATOR)
  })

  // ── IO 容错 ────────────────────────────────────────────────

  it('w1-tc8: loadPresetsFile JSON 畸形时空对象兜底不抛错', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(piPresetsPath(), '{ not valid json', 'utf-8')

    const all = presetService.getAllPresets()
    expect(all).toEqual(DEFAULT_PRESETS)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('w1-tc10: savePreset 新增自定义 preset 强制 builtin:false', () => {
    presetService.savePreset({
      id: 'uuid-1',
      name: '我的预设',
      // builtin 缺省
      order: 10,
      toolMode: 'all',
      extensionMode: 'all',
    } as PiLaunchPreset)

    const all = presetService.getAllPresets()
    const custom = all.find(p => p.id === 'uuid-1')
    expect(custom).toBeDefined()
    expect(custom!.builtin).toBe(false)

    // 即使传 builtin:true 也应被强制为 false
    presetService.savePreset({
      id: 'uuid-2',
      name: '伪造内置',
      builtin: true, // 试图伪造
      order: 11,
      toolMode: 'all',
      extensionMode: 'all',
    })
    const forged = presetService.getPreset('uuid-2')
    expect(forged).toBeDefined()
    expect(forged!.builtin).toBe(false)
  })
})
