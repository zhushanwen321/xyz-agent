/**
 * extension-filter.ts — 过滤管道纯函数测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { filterExtension, filterLoadablePaths, isPresetOverridable, readPkgMeta } from '../src/services/extension-filter.js'
import type { DiscoveredExtension } from '../src/services/ports/installer.js'

// Mock readPkgMeta for controlled testing
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn((path: string, encoding: string) => {
      // Return mock package.json based on directory name
      const dir = typeof path === 'string' ? path : ''
      if (dir.includes('pi-pending-notifications')) {
        return JSON.stringify({ name: '@zhushanwen/pi-pending-notifications', version: '1.0.0' })
      }
      if (dir.includes('pi-structured-output')) {
        return JSON.stringify({ name: '@zhushanwen/pi-structured-output', version: '1.0.0' })
      }
      if (dir.includes('pi-ask-user')) {
        return JSON.stringify({ name: '@zhushanwen/pi-ask-user', version: '1.0.0' })
      }
      if (dir.includes('pi-goal')) {
        return JSON.stringify({ name: '@zhushanwen/pi-goal', version: '1.0.0' })
      }
      if (dir.includes('normal-ext')) {
        return JSON.stringify({ name: 'normal-ext', version: '1.0.0' })
      }
      if (dir.includes('disabled-ext')) {
        return JSON.stringify({ name: 'disabled-ext', version: '1.0.0' })
      }
      throw new Error(`ENOENT: ${dir}`)
    }),
  }
})

describe('filterExtension', () => {
  const emptyDisabled = new Set<string>()

  it('infrastructure package always loads (even if disabled)', () => {
    const disabled = new Set(['npm:@zhushanwen/pi-pending-notifications'])
    expect(filterExtension('/ext/pi-pending-notifications', disabled)).toBe('load')
  })

  it('feature mandatory package always loads (even if disabled)', () => {
    const disabled = new Set(['npm:@zhushanwen/pi-ask-user'])
    expect(filterExtension('/ext/pi-ask-user', disabled)).toBe('load')
  })

  it('feature mandatory package (pi-goal) always loads', () => {
    expect(filterExtension('/ext/pi-goal', emptyDisabled)).toBe('load')
  })

  it('normal package loads when not disabled', () => {
    expect(filterExtension('/ext/normal-ext', emptyDisabled)).toBe('load')
  })

  it('normal package excluded when disabled', () => {
    const disabled = new Set(['npm:disabled-ext'])
    expect(filterExtension('/ext/disabled-ext', disabled)).toBe('exclude')
  })
})

describe('filterLoadablePaths', () => {
  it('returns paths of loadable extensions', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-pending-notifications', source: 'npm' },
      { path: '/ext/pi-ask-user', source: 'npm' },
      { path: '/ext/normal-ext', source: 'user' },
    ]
    const disabled = new Set<string>()
    const result = filterLoadablePaths(discovered, disabled)
    expect(result).toEqual([
      '/ext/pi-pending-notifications',
      '/ext/pi-ask-user',
      '/ext/normal-ext',
    ])
  })

  it('excludes disabled normal packages but keeps mandatory', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-pending-notifications', source: 'npm' },
      { path: '/ext/disabled-ext', source: 'user' },
      { path: '/ext/normal-ext', source: 'settings' },
    ]
    const disabled = new Set(['npm:disabled-ext'])
    const result = filterLoadablePaths(discovered, disabled)
    expect(result).toEqual([
      '/ext/pi-pending-notifications',
      '/ext/normal-ext',
    ])
  })

  it('returns empty for empty input', () => {
    expect(filterLoadablePaths([], new Set())).toEqual([])
  })
})

describe('isPresetOverridable', () => {
  it('infrastructure package is NOT overridable', () => {
    expect(isPresetOverridable('/ext/pi-pending-notifications')).toBe(false)
    expect(isPresetOverridable('/ext/pi-structured-output')).toBe(false)
  })

  it('feature mandatory package IS overridable', () => {
    expect(isPresetOverridable('/ext/pi-ask-user')).toBe(true)
    expect(isPresetOverridable('/ext/pi-goal')).toBe(true)
  })

  it('normal package IS overridable', () => {
    expect(isPresetOverridable('/ext/normal-ext')).toBe(true)
  })
})
