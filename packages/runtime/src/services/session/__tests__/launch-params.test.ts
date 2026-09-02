/**
 * launch-params 直测（S6 迁出批 3）：pi 启动参数组装纯函数族——skill 路径解析
 * （cwd resolve + expandHome + 存在性过滤）、extension 路径（断链 fail-fast / 其余降级）、
 * 替换系统提示词、launch preset 解析（builtin:full fallback）、buildPresetClientOptions
 * 组装（C-RL-6 覆盖优先序 + S-RT-5 thinking 值域校验 + 条件 spread）。
 *
 * 分层（G2：import 无 session-service）：expandHome 经 vi.mock 可编程（家目录前缀场景），
 * existsSync / resolve / 值域校验等生产逻辑真实执行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const expandHomeMock = vi.hoisted(() => vi.fn((p: string) => p))
vi.mock('../../../utils/path-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/path-utils.js')>()
  return { ...actual, expandHome: expandHomeMock }
})

import {
  resolveSkillPaths,
  resolveExtensionPaths,
  resolveReplaceSystemPrompt,
  resolveLaunchPresetOptions,
  buildPresetClientOptions,
} from '../launch-params.js'
import type { IConfigStore } from '../../ports/config.js'
import type { IExtensionService, IConfigService } from '../../../interfaces.js'
import type { PresetService, PresetResolution } from '../../preset-service.js'

function makeConfigStore(paths: string[]): IConfigStore {
  return { getSkillPaths: () => paths } as unknown as IConfigStore
}

function makePresetService(presets: Record<string, unknown>, resolveImpl?: (preset: unknown, cwd: string) => PresetResolution): PresetService {
  return {
    getPreset: (id: string) => presets[id],
    resolve: resolveImpl ?? ((preset: unknown) => preset as PresetResolution),
  } as unknown as PresetService
}

describe('resolveSkillPaths', () => {
  beforeEach(() => { expandHomeMock.mockImplementation((p: string) => p) })

  it('相对路径按 session cwd resolve 成绝对路径，不存在路径过滤掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-params-test-'))
    mkdirSync(join(dir, 'project-skills'))
    const result = resolveSkillPaths(
      makeConfigStore(['./project-skills', './missing-skill']),
      dir,
    )
    expect(result).toEqual([resolve(dir, 'project-skills')])
  })

  it('绝对路径直通（不与 cwd resolve）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-params-test-'))
    mkdirSync(join(dir, 'global-skills'))
    const absolute = join(dir, 'global-skills')
    const result = resolveSkillPaths(makeConfigStore([absolute]), '/other/cwd')
    expect(result).toEqual([absolute])
  })

  it('~ 前缀先 expandHome 展开再判绝对性（R1：相对 cwd 错位修复）', () => {
    const home = mkdtempSync(join(tmpdir(), 'fake-home-'))
    mkdirSync(join(home, 'agents-skills')) // 展开后的绝对路径真实存在（存在性过滤真跑）
    expandHomeMock.mockImplementation((p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p))
    const result = resolveSkillPaths(makeConfigStore(['~/agents-skills']), '/session/cwd')
    // 展开后是绝对路径，不再 resolve(cwd, ...) 错位
    expect(result).toEqual([join(home, 'agents-skills')])
  })
})

describe('resolveExtensionPaths', () => {
  it('正常透传 ExtensionService 结果', async () => {
    const ext = { getExtensionPaths: vi.fn(async () => ['/a', '/b']) } as unknown as IExtensionService
    await expect(resolveExtensionPaths(ext, '/cwd')).resolves.toEqual(['/a', '/b'])
    expect(ext.getExtensionPaths).toHaveBeenCalledWith('/cwd')
  })

  it('打包产物断链（BUILTIN_EXTENSIONS_MISSING）rethrow 不降级（fail-fast）', async () => {
    const err = Object.assign(new Error('builtin staged dir missing'), { code: 'BUILTIN_EXTENSIONS_MISSING' })
    const ext = { getExtensionPaths: vi.fn(async () => { throw err }) } as unknown as IExtensionService
    await expect(resolveExtensionPaths(ext)).rejects.toBe(err)
  })

  it('其余意外错误降级空列表（旧版兼容：不阻断会话）', async () => {
    const ext = { getExtensionPaths: vi.fn(async () => { throw new Error('flaky') }) } as unknown as IExtensionService
    await expect(resolveExtensionPaths(ext)).resolves.toEqual([])
  })
})

describe('resolveReplaceSystemPrompt', () => {
  it('未注入 ConfigService → undefined（pi 走默认系统提示词）', () => {
    expect(resolveReplaceSystemPrompt(null)).toBeUndefined()
    expect(resolveReplaceSystemPrompt(undefined)).toBeUndefined()
  })

  it('注入时委托 ConfigService.getReplaceSystemPrompt', () => {
    const config = { getReplaceSystemPrompt: () => 'custom prompt' } as unknown as IConfigService
    expect(resolveReplaceSystemPrompt(config)).toBe('custom prompt')
  })
})

describe('resolveLaunchPresetOptions', () => {
  it('presetService 未注入 → undefined', async () => {
    await expect(resolveLaunchPresetOptions(null, 'p1', '/cwd')).resolves.toBeUndefined()
  })

  it('preset 存在 → PresetService.resolve(preset, cwd)', async () => {
    const resolution = {} as PresetResolution
    const resolveSpy = vi.fn(() => resolution)
    const svc = makePresetService({ 'builtin:minimal': { id: 'builtin:minimal' } }, resolveSpy)
    await expect(resolveLaunchPresetOptions(svc, 'builtin:minimal', '/cwd')).resolves.toBe(resolution)
    expect(resolveSpy).toHaveBeenCalledWith({ id: 'builtin:minimal' }, '/cwd')
  })

  it('preset 被删/失效 → fallback builtin:full（全工具模式兜底，§4.3）', async () => {
    const full = { id: 'builtin:full' }
    const resolveSpy = vi.fn((preset: unknown) => preset as PresetResolution)
    const svc = makePresetService({ 'builtin:full': full }, resolveSpy)
    await expect(resolveLaunchPresetOptions(svc, 'deleted-preset', '/cwd')).resolves.toBe(full)
    expect(resolveSpy).toHaveBeenCalledWith(full, '/cwd')
  })

  it('builtin:full 也取不到（理论不可达）→ undefined', async () => {
    const svc = makePresetService({})
    await expect(resolveLaunchPresetOptions(svc, 'p1', '/cwd')).resolves.toBeUndefined()
  })
})

describe('buildPresetClientOptions', () => {
  /** 最小 resolution 形状（消费面字段）。 */
  function resolution(overrides: Partial<PresetResolution> = {}): PresetResolution {
    return {
      skillPaths: [],
      extensionPaths: [],
      toolArgs: {},
      flags: {},
      ...overrides,
    } as PresetResolution
  }

  it('resolution 与 override 全空 → 空对象（仅 override 生效语义的边界）', () => {
    expect(buildPresetClientOptions(undefined, undefined, undefined)).toEqual({})
  })

  it('preset 字段条件 spread：undefined/false 不出现（空数组是 truthy，按现状会透传）', () => {
    const result = buildPresetClientOptions(resolution({
      toolArgs: { tools: ['bash'], excludeTools: [] },
      flags: { noSkills: true, noContextFiles: false },
    }), undefined, undefined)
    expect(result).toEqual({ tools: ['bash'], excludeTools: [], noSkills: true })
    expect('noContextFiles' in result).toBe(false)
  })

  it('C-RL-6 优先序：Landing override > preset 同名字段', () => {
    const result = buildPresetClientOptions(
      resolution({ modelOverride: 'preset/model', thinkingLevel: 'high' } as Partial<PresetResolution>),
      'landing/model',
      'low',
    )
    expect(result.model).toBe('landing/model')
    expect(result.thinkingLevel).toBe('low')
  })

  it('override 缺省时继承 preset 字段', () => {
    const result = buildPresetClientOptions(
      resolution({ modelOverride: 'preset/model', thinkingLevel: 'high' } as Partial<PresetResolution>),
      undefined,
      undefined,
    )
    expect(result.model).toBe('preset/model')
    expect(result.thinkingLevel).toBe('high')
  })

  it('S-RT-5：非法 thinking 值（override 或 preset 侧）warn 后忽略', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = buildPresetClientOptions(
        undefined,
        undefined,
        'ultra-max' as never,
      )
      expect(result.thinkingLevel).toBeUndefined()
      expect(result).toEqual({})
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid thinking level'))
    } finally {
      warn.mockRestore()
    }
  })

  it('noTools 真值映射为 true（flag 布尔语义）', () => {
    const result = buildPresetClientOptions(resolution({
      toolArgs: { noTools: true },
    }), undefined, undefined)
    expect(result.noTools).toBe(true)
  })
})
