/**
 * extension-filter.ts — 过滤管道纯函数测试
 *
 * 重写适配新 API：
 *   - resolveExtension / resolveExtensions（disabled 过滤 + tier 推导，一次读盘）
 *   - applyPresetMode（preset extensionMode 二次筛选）
 *
 * 核心保证（S2）：infrastructure 包在任何 preset mode 下都绝对存活。
 * S8：畸形 package.json name（非 string）用 basename fallback。
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveExtensions, resolveExtension, applyPresetMode, type ResolvedExtension } from '../src/services/extension-filter.js'
import type { DiscoveredExtension } from '../src/services/ports/installer.js'

// 拦截 node:fs readFileSync：按目录名返回 mock package.json（与旧测试同模式）
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn((path: string) => {
      const dir = typeof path === 'string' ? path : ''
      // infrastructure mandatory
      if (dir.includes('pi-pending-notifications')) {
        return JSON.stringify({ name: '@zhushanwen/pi-pending-notifications', version: '1.0.0' })
      }
      if (dir.includes('pi-structured-output')) {
        return JSON.stringify({ name: '@zhushanwen/pi-structured-output', version: '1.0.0' })
      }
      // feature mandatory
      if (dir.includes('pi-ask-user')) {
        return JSON.stringify({ name: '@zhushanwen/pi-ask-user', version: '1.0.0' })
      }
      if (dir.includes('pi-goal')) {
        return JSON.stringify({ name: '@zhushanwen/pi-goal', version: '1.0.0' })
      }
      // 普通包
      if (dir.includes('normal-ext')) {
        return JSON.stringify({ name: 'normal-ext', version: '1.0.0' })
      }
      if (dir.includes('disabled-ext')) {
        return JSON.stringify({ name: 'disabled-ext', version: '1.0.0' })
      }
      // S8：畸形 name（非 string）—— resolveExtension 用 typeof 守卫 fallback 到 basename
      if (dir.includes('malformed-name-ext')) {
        return JSON.stringify({ name: 123, version: '1.0.0' })
      }
      throw new Error(`ENOENT: ${dir}`)
    }),
  }
})

describe('resolveExtensions', () => {
  it('infrastructure 包无视 disabled 强加载（pi-pending-notifications）', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-pending-notifications', source: 'npm' },
    ]
    const disabled = new Set(['npm:@zhushanwen/pi-pending-notifications'])
    const result = resolveExtensions(discovered, disabled)
    expect(result).toHaveLength(1)
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.presetOverridable).toBe(false)
    expect(result[0]!.tier).toBe('infrastructure')
    expect(result[0]!.name).toBe('@zhushanwen/pi-pending-notifications')
  })

  it('infrastructure 包 pi-structured-output 同样强加载', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-structured-output', source: 'npm' },
    ]
    const disabled = new Set(['npm:@zhushanwen/pi-structured-output'])
    const result = resolveExtensions(discovered, disabled)
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.presetOverridable).toBe(false)
    expect(result[0]!.tier).toBe('infrastructure')
  })

  it('feature mandatory 包无视 disabled 强加载（pi-ask-user）', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-ask-user', source: 'npm' },
    ]
    const disabled = new Set(['npm:@zhushanwen/pi-ask-user'])
    const result = resolveExtensions(discovered, disabled)
    expect(result[0]!.loadable).toBe(true)
    // feature 可被 preset 覆盖（与 infrastructure 的绝对强加载区分）
    expect(result[0]!.presetOverridable).toBe(true)
    expect(result[0]!.tier).toBe('feature')
  })

  it('feature mandatory 包 pi-goal 强加载', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-goal', source: 'npm' },
    ]
    const disabled = new Set(['npm:@zhushanwen/pi-goal'])
    const result = resolveExtensions(discovered, disabled)
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.presetOverridable).toBe(true)
    expect(result[0]!.tier).toBe('feature')
  })

  it('普通包未 disabled 时加载', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/normal-ext', source: 'user' },
    ]
    const result = resolveExtensions(discovered, new Set())
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.presetOverridable).toBe(true)
    expect(result[0]!.tier).toBeUndefined()
  })

  it('普通包 disabled 时排除（loadable=false）', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/disabled-ext', source: 'user' },
    ]
    const disabled = new Set(['npm:disabled-ext'])
    const result = resolveExtensions(discovered, disabled)
    expect(result[0]!.loadable).toBe(false)
    expect(result[0]!.presetOverridable).toBe(true)
    expect(result[0]!.tier).toBeUndefined()
  })

  it('混合批量保持输入顺序且各自判定正确', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-pending-notifications', source: 'npm' }, // infra
      { path: '/ext/pi-goal', source: 'npm' }, // feature
      { path: '/ext/normal-ext', source: 'user' }, // normal
      { path: '/ext/disabled-ext', source: 'user' }, // disabled normal
    ]
    const disabled = new Set(['npm:disabled-ext'])
    const result = resolveExtensions(discovered, disabled)
    expect(result).toHaveLength(4)
    // 保持输入顺序
    expect(result.map(r => r.path)).toEqual([
      '/ext/pi-pending-notifications',
      '/ext/pi-goal',
      '/ext/normal-ext',
      '/ext/disabled-ext',
    ])
    // [0] infra 强加载
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.tier).toBe('infrastructure')
    // [1] feature 强加载
    expect(result[1]!.loadable).toBe(true)
    expect(result[1]!.tier).toBe('feature')
    // [2] normal 未 disabled
    expect(result[2]!.loadable).toBe(true)
    expect(result[2]!.tier).toBeUndefined()
    // [3] normal 被 disabled
    expect(result[3]!.loadable).toBe(false)
    expect(result[3]!.tier).toBeUndefined()
  })

  it('空 discovered 返回空数组', () => {
    expect(resolveExtensions([], new Set())).toEqual([])
  })

  // S8：畸形 package.json name（非 string）fallback 到 basename
  it('S8: 畸形 package.json name（非 string）fallback 到 basename', () => {
    const dir = '/ext/malformed-name-ext'
    const result = resolveExtension(dir, new Set())
    // name 字段为 number（123），typeof 守卫失败 → fallback 到 basename(dir)
    expect(result.name).toBe('malformed-name-ext')
    // basename 不是 mandatory 包 → 普通处理：未 disabled 则 loadable
    expect(result.loadable).toBe(true)
    expect(result.tier).toBeUndefined()
    expect(result.presetOverridable).toBe(true)
  })
})

describe('applyPresetMode', () => {
  // 共享 fixture：三类包各一个，均已 resolve（loadable=true）
  // - pi-pending-notifications（infrastructure，presetOverridable=false）
  // - pi-goal（feature mandatory，presetOverridable=true）
  // - normal-ext（普通包，presetOverridable=true）
  const makeResolvedFixture = (): ResolvedExtension[] => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-pending-notifications', source: 'npm' },
      { path: '/ext/pi-goal', source: 'npm' },
      { path: '/ext/normal-ext', source: 'user' },
    ]
    // 不 disable 任何包 → 三者 loadable 都 true
    return resolveExtensions(discovered, new Set())
  }

  it('none 模式只保留 infrastructure', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'none', [], [])
    expect(result).toHaveLength(1)
    expect(result[0]!.tier).toBe('infrastructure')
    expect(result[0]!.name).toBe('@zhushanwen/pi-pending-notifications')
    // 不含 feature / normal
    expect(result.some(r => r.name === '@zhushanwen/pi-goal')).toBe(false)
    expect(result.some(r => r.name === 'normal-ext')).toBe(false)
  })

  it('all 模式全保留', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'all', [], [])
    expect(result).toHaveLength(3)
    expect(result.map(r => r.name)).toEqual([
      '@zhushanwen/pi-pending-notifications',
      '@zhushanwen/pi-goal',
      'normal-ext',
    ])
  })

  it('allowlist 模式 infrastructure 存活即使不在 allowlist', () => {
    const resolved = makeResolvedFixture()
    // allowlist 只含 normal-ext（不含 infra 也不含 feature）
    const result = applyPresetMode(resolved, 'allowlist', ['normal-ext'], [])
    const names = result.map(r => r.name)
    // infra 存活（不在 allowlist 也留）
    expect(names).toContain('@zhushanwen/pi-pending-notifications')
    // normal-ext 在 allowlist 内
    expect(names).toContain('normal-ext')
    // feature（pi-goal）不在 allowlist → 被排除
    expect(names).not.toContain('@zhushanwen/pi-goal')
    expect(result).toHaveLength(2)
  })

  it('allowlist 模式 feature 在 allowlist 内时保留', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'allowlist', ['@zhushanwen/pi-goal', 'normal-ext'], [])
    expect(result).toHaveLength(3)
    expect(result.map(r => r.name)).toEqual([
      '@zhushanwen/pi-pending-notifications',
      '@zhushanwen/pi-goal',
      'normal-ext',
    ])
  })

  it('denylist 模式 infrastructure 存活即使被列入 denylist', () => {
    const resolved = makeResolvedFixture()
    // 三个都 deny
    const result = applyPresetMode(resolved, 'denylist', [], [
      '@zhushanwen/pi-pending-notifications',
      '@zhushanwen/pi-goal',
      'normal-ext',
    ])
    const names = result.map(r => r.name)
    // infra 扛住 denylist（即使被列入也留）
    expect(names).toContain('@zhushanwen/pi-pending-notifications')
    // feature / normal 被 deny
    expect(names).not.toContain('@zhushanwen/pi-goal')
    expect(names).not.toContain('normal-ext')
    expect(result).toHaveLength(1)
  })

  it('denylist 模式排除列出的 feature/normal', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'denylist', [], ['@zhushanwen/pi-goal'])
    const names = result.map(r => r.name)
    // infra + normal 留；feature 被 deny
    expect(names).toContain('@zhushanwen/pi-pending-notifications')
    expect(names).toContain('normal-ext')
    expect(names).not.toContain('@zhushanwen/pi-goal')
    expect(result).toHaveLength(2)
  })

  it('空 allowlist + allowlist 模式只留 infrastructure', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'allowlist', [], [])
    expect(result).toHaveLength(1)
    expect(result[0]!.tier).toBe('infrastructure')
  })

  // 本次重构最关键的保证：infrastructure 在所有 4 种 preset mode 下都绝对存活
  it('infrastructure 包在任何 preset mode 下都绝对存活（核心保证）', () => {
    const resolved = makeResolvedFixture()
    const infraPath = '/ext/pi-pending-notifications'
    const modes = ['none', 'allowlist', 'denylist', 'all'] as const
    for (const mode of modes) {
      // denylist 故意把 infra 也列进去，验证它扛住
      const result = applyPresetMode(resolved, mode, [], ['@zhushanwen/pi-pending-notifications'])
      const paths = result.map(r => r.path)
      expect(paths).toContain(infraPath)
    }
  })
})
