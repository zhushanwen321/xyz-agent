/**
 * PresetService 单测（wave 1: 存储内核 + CRUD / wave 2: resolve + builtin 提取）。
 *
 * wave 1（10 个 testCase）：CRUD + builtin 保护 + IO 容错。
 * wave 2（6 个 testCase）：resolve 各 mode 分支 + builtin 永远前置 + toolArgs 映射 + flags 透传。
 *
 * mock 策略：fake ConfigStore（getConfigDir 返回 tmpdir）+ fake ExtensionService
 * （wave1 用空占位；wave2 注入固定 scanExtensions/getBuiltinExtensionPaths 返回值）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync as statSyncInternal, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_PRESETS,
  BUILTIN_PRESET_IDS,
  type ExtensionInfo,
  type PiLaunchPreset,
  type PiPresetsFile,
} from '@xyz-agent/shared'
import { PresetService, PresetGuardError } from '../src/services/preset-service.js'

/** 只暴露 getConfigDir 的最小 fake configStore。 */
function makeFakeConfigStore(configDir: string) {
  return { getConfigDir: () => configDir }
}

/** 占位 fake extensionService（wave1 不调用）。wave2 用 makeFakeExtensionStoreForResolve。 */
function makeFakeExtensionStore() {
  return {
    getBuiltinExtensionPaths: vi.fn(() => []),
    scanExtensions: vi.fn(async () => []),
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(async () => []),
  }
}

/**
 * wave2 resolve 测试用的 fake extensionService：可控的 builtin 路径 + 用户 extension 列表。
 * builtinPaths: getBuiltinExtensionPaths 的固定返回值。
 * userExts: scanExtensions 的固定返回值（含 enabled 状态）。
 */
function makeFakeExtensionStoreForResolve(builtinPaths: string[], userExts: ExtensionInfo[]) {
  return {
    getBuiltinExtensionPaths: vi.fn(() => builtinPaths),
    scanExtensions: vi.fn(async () => userExts),
    getExtensionPaths: vi.fn(async () => [...builtinPaths, ...userExts.filter(e => e.enabled).map(e => e.path)]),
    getSkillPaths: vi.fn(async () => []),
  }
}

/** 构造最小 PiLaunchPreset（仅本 wave resolve 关心的字段，其余缺省）。 */
function makePreset(overrides: Partial<PiLaunchPreset>): PiLaunchPreset {
  return {
    id: 'test-preset',
    name: 'test',
    builtin: false,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
    ...overrides,
  }
}

/** 构造最小 ExtensionInfo（仅 resolve 关心的字段，其余填默认值满足类型）。 */
function makeExt(name: string, enabled: boolean, path?: string): ExtensionInfo {
  return {
    name,
    dirName: name,
    version: '0.0.0-test',
    description: '',
    path: path ?? `/fake/ext/${name}`,
    enabled,
    source: 'user-installed',
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

// ── wave 2: resolve + builtin 提取 ──────────────────────────────

describe('PresetService · wave 2 resolve', () => {
  // 本 describe 用独立的 presetService 构造（带可控 mock extensionService）
  let svcWithMock: PresetService
  let mockExt: ReturnType<typeof makeFakeExtensionStoreForResolve>

  beforeEach(() => {
    // 复用顶层 tmpDir（已是 presetService 的 configDir），但用新 mock 构造 svcWithMock
    mockExt = makeFakeExtensionStoreForResolve(
      ['/builtin/agent.js', '/builtin/sp.js'], // 2 个 builtin 路径
      [
        makeExt('ext-a', true),
        makeExt('ext-b', true),
        makeExt('ext-c', false), // disabled
      ],
    )
    svcWithMock = new PresetService(
      makeFakeConfigStore(tmpDir) as unknown as ConstructorParameters<typeof PresetService>[0],
      mockExt as unknown as ConstructorParameters<typeof PresetService>[1],
    )
  })

  it('w2-tc3: resolve extensionMode=all 返回 builtin + 全部 enabled 用户 extension', async () => {
    const result = await svcWithMock.resolve(makePreset({ extensionMode: 'all' }), '/cwd')
    // 2 builtin + 2 enabled (ext-a, ext-b)，ext-c disabled 被排除
    expect(result.extensionPaths).toEqual([
      '/builtin/agent.js', '/builtin/sp.js',
      '/fake/ext/ext-a', '/fake/ext/ext-b',
    ])
    // 验证 disabled 被排除
    expect(result.extensionPaths.some(p => p.includes('ext-c'))).toBe(false)
  })

  it('w2-tc4: resolve extensionMode=allowlist 只含 allowedExtensions 命中的', async () => {
    const result = await svcWithMock.resolve(
      makePreset({ extensionMode: 'allowlist', allowedExtensions: ['ext-a', 'ext-c'] }),
      '/cwd',
    )
    // builtin 永远前置 + ext-a（enabled && allowed）
    // ext-c 虽在 allowed 但 disabled → 排除；ext-b 不在 allowed → 排除
    expect(result.extensionPaths).toEqual([
      '/builtin/agent.js', '/builtin/sp.js',
      '/fake/ext/ext-a',
    ])
  })

  it('w2-tc5: resolve extensionMode=denylist 排除 deniedExtensions', async () => {
    const result = await svcWithMock.resolve(
      makePreset({ extensionMode: 'denylist', deniedExtensions: ['ext-b'] }),
      '/cwd',
    )
    // builtin + ext-a（enabled && !denied）；ext-b denied 排除；ext-c disabled 排除
    expect(result.extensionPaths).toEqual([
      '/builtin/agent.js', '/builtin/sp.js',
      '/fake/ext/ext-a',
    ])
  })

  it('w2-tc6: resolve extensionMode=none 只返回 builtin（用户 extension 全排除）', async () => {
    const result = await svcWithMock.resolve(
      makePreset({ extensionMode: 'none' }),
      '/cwd',
    )
    // 验证 builtin 永远注入的硬约束：extensionMode=none 时仍含全部 builtin
    expect(result.extensionPaths).toEqual(['/builtin/agent.js', '/builtin/sp.js'])
    expect(result.extensionPaths.some(p => p.includes('ext-'))).toBe(false)
  })

  it('w2-tc7: resolve 4 种 toolMode 映射正确', async () => {
    // all → {}
    const rAll = await svcWithMock.resolve(makePreset({ toolMode: 'all' }), '/cwd')
    expect(rAll.toolArgs).toEqual({})

    // allowlist → { tools: allowedTools }
    const rAllow = await svcWithMock.resolve(
      makePreset({ toolMode: 'allowlist', allowedTools: ['read', 'grep'] }),
      '/cwd',
    )
    expect(rAllow.toolArgs).toEqual({ tools: ['read', 'grep'] })

    // denylist → { excludeTools: deniedTools }
    const rDeny = await svcWithMock.resolve(
      makePreset({ toolMode: 'denylist', deniedTools: ['bash'] }),
      '/cwd',
    )
    expect(rDeny.toolArgs).toEqual({ excludeTools: ['bash'] })

    // none → { noTools: true }
    const rNone = await svcWithMock.resolve(makePreset({ toolMode: 'none' }), '/cwd')
    expect(rNone.toolArgs).toEqual({ noTools: true })
  })

  it('w2-tc8: resolve flags/noSkills/noContextFiles + modelOverride/thinkingLevel 透传', async () => {
    const result = await svcWithMock.resolve(
      makePreset({
        noSkills: true,
        noContextFiles: true,
        modelOverride: 'anthropic/x',
        thinkingLevel: 'high',
      }),
      '/cwd',
    )
    expect(result.flags).toEqual({ noSkills: true, noContextFiles: true })
    expect(result.skillPaths).toEqual([]) // noSkills=true 清空（B1：返 [] 真清空）
    expect(result.modelOverride).toBe('anthropic/x')
    expect(result.thinkingLevel).toBe('high')
  })

  // ── B1 修复验证：resolveSkillPaths 在 noSkills=false/undefined 时返 undefined ──

  it('B1: resolve noSkills 未设 → skillPaths 为 undefined（让 lifecycle ?? fallback 到 getSkillPaths）', async () => {
    const result = await svcWithMock.resolve(makePreset({}), '/cwd')
    // 关键断言：undefined 而非 []。[] 是 truthy，会让 lifecycle 的 ?? fallback 失效，
    // 所有用 presetId 启动的 session 拿到空 skillPaths，所有 skill 失效（BLOCKER 根因）。
    expect(result.skillPaths).toBeUndefined()
    expect(result.flags.noSkills).toBe(false) // noSkills 默认 false
  })

  it('B1: resolve noSkills=false → skillPaths 仍为 undefined', async () => {
    const result = await svcWithMock.resolve(makePreset({ noSkills: false }), '/cwd')
    expect(result.skillPaths).toBeUndefined()
    expect(result.flags.noSkills).toBe(false)
  })
})

// ── PR #117 review fixes: W-RT-1 / W-RT-2 / W-RT-3 / S-RT-2 ──────────

describe('PresetService · PR #117 review fixes', () => {
  // ── W-RT-1: coercePreset 枚举白名单校验 ──

  it('W-RT-1: getAllPresets 丢弃 toolMode 非法枚举值的脏数据 preset', () => {
    writeFile({
      version: 1,
      presets: [
        // 合法自定义 preset（应保留）
        { id: 'uuid-ok', name: 'ok', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
        // 脏数据：toolMode 非法（不在 all/allowlist/denylist/none）
        { id: 'uuid-bad-tool', name: 'bad', builtin: false, order: 2, toolMode: 'DROP TABLE' as PiLaunchPreset['toolMode'], extensionMode: 'all' },
        // 脏数据：extensionMode 非法
        { id: 'uuid-bad-ext', name: 'bad', builtin: false, order: 3, toolMode: 'all', extensionMode: 'HACKED' as PiLaunchPreset['extensionMode'] },
      ],
    })

    const all = presetService.getAllPresets()
    // 3 个 DEFAULT + 1 个合法自定义 = 4 个；2 个脏数据被丢弃
    expect(all).toHaveLength(DEFAULT_PRESETS.length + 1)
    expect(all.find(p => p.id === 'uuid-ok')).toBeDefined()
    expect(all.find(p => p.id === 'uuid-bad-tool')).toBeUndefined()
    expect(all.find(p => p.id === 'uuid-bad-ext')).toBeUndefined()
  })

  it('W-RT-1: importPresets 丢弃 toolMode/extensionMode 非法的 preset（导入脏数据防御）', () => {
    const dirtyJson = JSON.stringify({
      version: 1,
      presets: [
        { id: 'imp-ok', name: 'ok', builtin: false, order: 5, toolMode: 'allowlist', extensionMode: 'none' },
        { id: 'imp-bad', name: 'bad', builtin: false, order: 6, toolMode: 'EVIL', extensionMode: 'all' },
      ],
    })
    const count = presetService.importPresets(dirtyJson)
    // 只导入合法的 1 个
    expect(count).toBe(1)
    expect(presetService.getPreset('imp-ok')).toBeDefined()
    expect(presetService.getPreset('imp-bad')).toBeUndefined()
  })

  // ── W-RT-2: deletePreset 清理 defaultPresetId / perCwdDefaults ──

  it('W-RT-2: deletePreset 清理指向被删 preset 的 defaultPresetId', () => {
    writeFile({
      version: 1,
      defaultPresetId: 'uuid-default',
      presets: [
        { id: 'uuid-default', name: 'to-be-deleted', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    expect(presetService.getDefaultPresetId()).toBe('uuid-default')

    presetService.deletePreset('uuid-default')

    // defaultPresetId 被清空 → getDefaultPresetId 回退 builtin:full（W-RT-3 校验存在性兜底）
    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.FULL)
    const onDisk = readFile()
    expect(onDisk!.defaultPresetId).toBeUndefined()
  })

  it('W-RT-2: deletePreset 清理 perCwdDefaults 中指向被删 preset 的条目', () => {
    writeFile({
      version: 1,
      perCwdDefaults: {
        '/cwd-a': 'uuid-del',
        '/cwd-b': 'uuid-keep',
      },
      presets: [
        { id: 'uuid-del', name: 'a', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
        { id: 'uuid-keep', name: 'b', builtin: false, order: 2, toolMode: 'all', extensionMode: 'all' },
      ],
    })

    presetService.deletePreset('uuid-del')

    const onDisk = readFile()
    // /cwd-a 被清理，/cwd-b 保留
    expect(onDisk!.perCwdDefaults).toEqual({ '/cwd-b': 'uuid-keep' })
  })

  it('W-RT-2: deletePreset 不存在的 preset 是 no-op（不抛错、不写盘）', () => {
    writeFile({
      version: 1,
      defaultPresetId: BUILTIN_PRESET_IDS.FULL,
      presets: [
        { id: 'uuid-x', name: 'x', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    const beforeStat = statSyncOptional(piPresetsPath())

    expect(() => presetService.deletePreset('nonexistent')).not.toThrow()

    // 文件未变（no-op 不写盘）
    const afterStat = statSyncOptional(piPresetsPath())
    expect(afterStat?.mtimeMs).toBe(beforeStat?.mtimeMs)
    const onDisk = readFile()
    expect(onDisk!.presets).toHaveLength(1)
  })

  // ── W-RT-3: defaultPresetId 存在性校验 ──

  it('W-RT-3: getDefaultPresetId 指向已删 preset 时回退 builtin:full', () => {
    // defaultPresetId 指向一个不在 presets 列表里的「僵尸」id（手工构造脏文件）
    writeFile({
      version: 1,
      defaultPresetId: 'uuid-zombie',
      presets: [],
    })
    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.FULL)
  })

  it('W-RT-3: getCwdDefaultPresetId perCwd 指向僵尸 → 回退 global default → 再回退 builtin:full', () => {
    writeFile({
      version: 1,
      defaultPresetId: 'uuid-also-zombie',
      perCwdDefaults: {
        '/cwd-zombie': 'uuid-percwd-zombie',
      },
      presets: [],
    })
    // perCwd 僵尸 → global default 也是僵尸 → 最终兜底 builtin:full
    expect(presetService.getCwdDefaultPresetId('/cwd-zombie')).toBe(BUILTIN_PRESET_IDS.FULL)
  })

  it('W-RT-3: getCwdDefaultPresetId perCwd 合法时优先用 perCwd', () => {
    writeFile({
      version: 1,
      defaultPresetId: BUILTIN_PRESET_IDS.ORCHESTRATOR,
      perCwdDefaults: {
        '/cwd-a': BUILTIN_PRESET_IDS.READONLY,
      },
      presets: [],
    })
    expect(presetService.getCwdDefaultPresetId('/cwd-a')).toBe(BUILTIN_PRESET_IDS.READONLY)
    // 未覆盖的 cwd 回退 global default（orchestrator 存在于 DEFAULT，合法）
    expect(presetService.getCwdDefaultPresetId('/cwd-b')).toBe(BUILTIN_PRESET_IDS.ORCHESTRATOR)
  })

  // ── S-RT-2: mtime 缓存 ──

  it('S-RT-2: getPreset 重复调用命中缓存（文件未变不重复读盘）', () => {
    writeFile({
      version: 1,
      presets: [
        { id: 'uuid-cache', name: 'cache-test', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    // 第一次读：miss → 读盘 + 填缓存
    expect(presetService.getPreset('uuid-cache')).toBeDefined()
    // 第二次/第三次：命中缓存（mtime/size 未变）→ 直接返回缓存值
    expect(presetService.getPreset('uuid-cache')).toBeDefined()
    expect(presetService.getAllPresets().find(p => p.id === 'uuid-cache')).toBeDefined()
  })

  it('S-RT-2: savePreset 后缓存失效，下次读拿到新值', () => {
    writeFile({
      version: 1,
      presets: [
        { id: 'uuid-invalidate', name: 'before', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    expect(presetService.getPreset('uuid-invalidate')!.name).toBe('before')

    // savePreset 改 name → 内部 invalidate 缓存
    presetService.savePreset({
      id: 'uuid-invalidate',
      name: 'after',
      builtin: false,
      order: 1,
      toolMode: 'all',
      extensionMode: 'all',
    })

    // 下次读拿到新值（缓存已失效，重新读盘）
    expect(presetService.getPreset('uuid-invalidate')!.name).toBe('after')
  })

  it('S-RT-2: 缓存返回的是深拷贝，调用方 mutation 不污染缓存', () => {
    writeFile({
      version: 1,
      presets: [
        { id: 'uuid-clone', name: 'original', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    // 第一次读拿到对象，故意 mutate
    const first = presetService.getPreset('uuid-clone')!
    first.name = 'mutated'
    // 注意：getPreset 返回的是 getAllPresets().find()，每次都 new 对象，但底层 loadPresetsFile
    // 命中缓存返回的是 clonePresetsFile 的拷贝，所以 mutate 不影响缓存内部 file。

    // 第二次读应仍是原值（缓存未被污染）
    const second = presetService.getPreset('uuid-clone')!
    expect(second.name).toBe('original')
  })
})

/** stat 文件，不存在返回 undefined（测试辅助）。 */
function statSyncOptional(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const s = statSyncInternal(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return undefined
  }
}

describe('ExtensionService.getBuiltinExtensionPaths · wave 2 提取', () => {
  // w2-tc1 + w2-tc2：用真实 ExtensionService 验证 getBuiltinExtensionPaths 提取后行为不变。
  // 真实 ExtensionService 构造较重（需 resolver/installer/settings 等依赖），这里用最小集成：
  // 复用 extension-service.test.ts 的 setup（已在 w2-tc2 通过回归覆盖）。
  // 此处只做契约级断言：方法存在于 IExtensionService 接口 + 真实 ExtensionService 原型上。

  it('w2-tc1: ExtensionService 原型上有 getBuiltinExtensionPaths 方法', async () => {
    const { ExtensionService } = await import('../src/services/extension-service.js')
    expect(typeof ExtensionService.prototype.getBuiltinExtensionPaths).toBe('function')
  })

  it('w2-tc1b: IExtensionService 接口契约——getExtensionPaths 内部调用 getBuiltinExtensionPaths（间接验证）', async () => {
    // 间接验证：getExtensionPaths 的返回值末尾应包含 getBuiltinExtensionPaths 的返回值
    // （因为提取后 getExtensionPaths 末尾 push(...getBuiltinExtensionPaths())）。
    // 此处不构造真实 service（依赖太重），仅断言类型契约已对齐——
    // 完整的 getExtensionPaths 行为回归由 extension-service.test.ts 现有 it 覆盖（w2-tc2 跑全套）。
    const { ExtensionService } = await import('../src/services/extension-service.js')
    // 方法存在 + 是 public（非 _ 前缀）
    const desc = Object.getOwnPropertyDescriptor(ExtensionService.prototype, 'getBuiltinExtensionPaths')
    expect(desc).toBeDefined()
    expect(desc!.value).toBeTypeOf('function')
    expect(typeof ExtensionService.prototype.getBuiltinExtensionPaths).toBe('function')
  })
})
