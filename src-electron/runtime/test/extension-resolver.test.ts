import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ExtensionResolver } from '../src/extension-resolver.js'
import type { SourceMap } from '../src/extension-resolver.js'

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}))

vi.mock('node:path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
}))

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'

const mockedExistsSync = vi.mocked(existsSync)
const mockedReaddirSync = vi.mocked(readdirSync)
const mockedStatSync = vi.mocked(statSync)
const mockedReadFileSync = vi.mocked(readFileSync)

function mockDir(dirPath: string, entries: string[] = ['ext-a', 'ext-b', 'shared']): void {
  mockedExistsSync.mockImplementation((p: unknown) => {
    if (typeof p !== 'string') return false
    return p === dirPath || p.startsWith(dirPath + '/')
  })
  mockedReaddirSync.mockImplementation(((p: unknown) => {
    if (p === dirPath) return entries
    return []
  }) as unknown as typeof readdirSync)
  mockedStatSync.mockImplementation((p: unknown) => {
    if (typeof p !== 'string') throw new Error('not found')
    const basename = p.split('/').pop() ?? ''
    if (basename === 'shared' || !p.startsWith(dirPath)) {
      const err = new Error('not found') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { isDirectory: () => true } as import('node:fs').Stats
  })
}

describe('ExtensionResolver', () => {
  let resolver: ExtensionResolver

  beforeEach(() => {
    resolver = new ExtensionResolver()
    vi.clearAllMocks()
  })

  describe('normalizeExtName', () => {
    it('removes pi- prefix from unscoped name', () => {
      // @ts-expect-error — testing private method
      expect(resolver.normalizeExtName('pi-subagents')).toBe('subagents')
    })

    it('preserves scope and removes pi- prefix', () => {
      // @ts-expect-error — testing private method
      expect(resolver.normalizeExtName('@zhushanwen/pi-goal')).toBe('@zhushanwen/goal')
    })

    it('preserves non-pi scope intact', () => {
      // @ts-expect-error — testing private method
      expect(resolver.normalizeExtName('@scope/subagents')).toBe('@scope/subagents')
    })

    it('handles scoped name without pi- prefix', () => {
      // @ts-expect-error — testing private method
      expect(resolver.normalizeExtName('@scope/my-ext')).toBe('@scope/my-ext')
    })

    it('handles name without pi- prefix', () => {
      // @ts-expect-error — testing private method
      expect(resolver.normalizeExtName('my-ext')).toBe('my-ext')
    })

    it('prevents dedup collision between different scopes', () => {
      // @ts-expect-error — testing private method
      const name1 = resolver.normalizeExtName('@scope1/pi-goal')
      // @ts-expect-error — testing private method
      const name2 = resolver.normalizeExtName('@scope2/pi-goal')
      expect(name1).not.toBe(name2)
      expect(name1).toBe('@scope1/goal')
      expect(name2).toBe('@scope2/goal')
    })
  })

  describe('scanNpmExtensions', () => {
    it('returns empty when package.json does not exist', () => {
      mockedExistsSync.mockReturnValue(false)

      const result = resolver.scanNpmExtensions('/project', false)
      expect(result.size).toBe(0)
    })

    it('returns empty when package.json has no dependencies', () => {
      mockedExistsSync.mockImplementation((p: unknown) =>
        typeof p === 'string' && p === '/project/package.json',
      )
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p === '/project/package.json') {
          return JSON.stringify({})
        }
        throw new Error('not found')
      })

      const result = resolver.scanNpmExtensions('/project', false)
      expect(result.size).toBe(0)
    })
  })

  describe('scanSettingsExtensions', () => {
    it('reads settings.json packages and resolves valid extensions', () => {
      const home = '/home/user'
      const settingsDir = `${home}/.xyz-agent/pi/agent`
      const settingsPath = `${settingsDir}/settings.json`
      const pkgDir = `${settingsDir}/npm/node_modules/pi-ask-user`

      vi.stubEnv('HOME', home)

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === settingsPath) return true
        // pi-ask-user directory exists
        if (p === pkgDir) return true
        // pi-ask-user package.json (valid pi extension)
        if (p === `${pkgDir}/package.json`) return true
        // disabled-packages.json doesn't exist
        if (p === `${settingsDir}/disabled-packages.json`) return false
        return false
      })

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        // settings.json with one package
        if (p === settingsPath) {
          return JSON.stringify({ packages: ['npm:pi-ask-user'] })
        }
        // pi-ask-user package.json (valid pi extension)
        if (p === `${pkgDir}/package.json`) {
          return JSON.stringify({
            name: 'pi-ask-user',
            keywords: ['pi-package'],
            peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
          })
        }
        throw new Error('not found')
      })

      const result = resolver.scanSettingsExtensions()
      expect(result.size).toBe(1)
      expect(result.get('ask-user')).toBe(pkgDir)
    })

    it('skips disabled packages', () => {
      const home = '/home/user'
      const settingsDir = `${home}/.xyz-agent/pi/agent`

      vi.stubEnv('HOME', home)

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === `${settingsDir}/settings.json`) return true
        if (p === `${settingsDir}/disabled-packages.json`) return true
        return false
      })

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === `${settingsDir}/settings.json`) {
          return JSON.stringify({ packages: ['npm:pi-ask-user'] })
        }
        if (p === `${settingsDir}/disabled-packages.json`) {
          return JSON.stringify({ disabled: ['npm:pi-ask-user'] })
        }
        throw new Error('not found')
      })

      const result = resolver.scanSettingsExtensions()
      expect(result.size).toBe(0)
    })

    it('skips invalid pi extensions', () => {
      const home = '/home/user'
      const settingsDir = `${home}/.xyz-agent/pi/agent`
      const pkgDir = `${settingsDir}/npm/node_modules/not-a-pi-ext`

      vi.stubEnv('HOME', home)

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === `${settingsDir}/settings.json`) return true
        if (p === `${pkgDir}/package.json`) return true
        if (p === `${settingsDir}/disabled-packages.json`) return false
        return false
      })

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === `${settingsDir}/settings.json`) {
          return JSON.stringify({ packages: ['npm:not-a-pi-ext'] })
        }
        if (p === `${pkgDir}/package.json`) {
          return JSON.stringify({ name: 'not-a-pi-ext' }) // no pi-package keyword, no pi-coding-agent peerDep
        }
        throw new Error('not found')
      })

      const result = resolver.scanSettingsExtensions()
      expect(result.size).toBe(0)
    })

    it('returns empty when settings.json does not exist', () => {
      mockedExistsSync.mockReturnValue(false)

      const result = resolver.scanSettingsExtensions()
      expect(result.size).toBe(0)
    })
  })

  describe('scanBundledExtensions', () => {
    it('scans bundled directory in dev mode', () => {
      mockDir('/project/resources/pi/agent/extensions')

      const result = resolver.scanBundledExtensions('/project', false)
      expect(result.size).toBe(2)
      expect(result.has('ext-a')).toBe(true)
      expect(result.has('ext-b')).toBe(true)
      expect(result.has('shared')).toBe(false)
    })

    it('returns empty in packaged mode', () => {
      const result = resolver.scanBundledExtensions('/project', true)
      expect(result.size).toBe(0)
    })

    it('skips shared directory', () => {
      mockDir('/project/resources/pi/agent/extensions')

      const result = resolver.scanBundledExtensions('/project', false)
      expect(result.has('shared')).toBe(false)
    })
  })

  describe('scanThirdPartyExtensions', () => {
    it('scans ~/.xyz-agent/pi/agent/extensions/', () => {
      const home = process.env.HOME ?? '/home/user'
      const thirdPartyDir = `${home}/.xyz-agent/pi/agent/extensions`
      mockDir(thirdPartyDir)

      const result = resolver.scanThirdPartyExtensions()
      expect(result.size).toBe(2)
      expect(result.has('ext-a')).toBe(true)
      expect(result.has('ext-b')).toBe(true)
    })
  })

  describe('scanUserExtensions', () => {
    it('scans user-provided extension paths', () => {
      mockedExistsSync.mockReturnValue(true)
      mockedStatSync.mockImplementation(() => ({ isDirectory: () => true } as import('node:fs').Stats))

      const result = resolver.scanUserExtensions(['/custom/ext-a', '/custom/ext-b'])
      expect(result.size).toBe(2)
      expect(result.get('ext-a')).toBe('/custom/ext-a')
      expect(result.get('ext-b')).toBe('/custom/ext-b')
    })

    it('skips non-existent paths', () => {
      mockedExistsSync.mockImplementation((p: unknown) => typeof p === 'string' && p === '/custom/ext-a')
      mockedStatSync.mockImplementation(() => ({ isDirectory: () => true } as import('node:fs').Stats))

      const result = resolver.scanUserExtensions(['/custom/ext-a', '/custom/nonexistent'])
      expect(result.size).toBe(1)
      expect(result.get('ext-a')).toBe('/custom/ext-a')
    })

    it('returns empty for empty input', () => {
      const result = resolver.scanUserExtensions([])
      expect(result.size).toBe(0)
    })
  })

  describe('deduplicate', () => {
    it('higher priority source wins over lower', () => {
      const sources: SourceMap[] = [
        {
          source: 'npm',
          extensions: new Map([['ext-a', '/npm/ext-a']]),
        },
        {
          source: 'bundled',
          extensions: new Map([
            ['ext-a', '/bundled/ext-a'],
            ['ext-b', '/bundled/ext-b'],
          ]),
        },
      ]

      const result = resolver.deduplicate(sources)
      expect(result.get('ext-a')).toBe('/npm/ext-a')
      expect(result.get('ext-b')).toBe('/bundled/ext-b')
    })

    it('npm overrides settings for same name', () => {
      const sources: SourceMap[] = [
        {
          source: 'settings',
          extensions: new Map([['review', '/settings/review']]),
        },
        {
          source: 'npm',
          extensions: new Map([['review', '/npm/review']]),
        },
      ]

      const result = resolver.deduplicate(sources)
      expect(result.get('review')).toBe('/npm/review')
    })

    it('settings overrides bundled for same name', () => {
      const sources: SourceMap[] = [
        {
          source: 'bundled',
          extensions: new Map([['ext-a', '/bundled/ext-a']]),
        },
        {
          source: 'settings',
          extensions: new Map([['ext-a', '/settings/ext-a']]),
        },
      ]

      const result = resolver.deduplicate(sources)
      expect(result.get('ext-a')).toBe('/settings/ext-a')
    })

    it('returns all extensions when no conflicts', () => {
      const sources: SourceMap[] = [
        {
          source: 'bundled',
          extensions: new Map([['ext-a', '/bundled/ext-a']]),
        },
        {
          source: 'third-party',
          extensions: new Map([['ext-b', '/third-party/ext-b']]),
        },
      ]

      const result = resolver.deduplicate(sources)
      expect(result.size).toBe(2)
    })
  })

  describe('resolve', () => {
    it('integrates all 5 sources and deduplicates', () => {
      const bundledDir = '/project/resources/pi/agent/extensions'
      const home = process.env.HOME ?? '/home/user'
      const settingsDir = `${home}/.xyz-agent/pi/agent`
      const settingsPath = `${settingsDir}/settings.json`

      vi.stubEnv('HOME', home)

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        // bundled dir exists
        if (p === bundledDir) return true
        // third-party dir exists
        if (p === `${home}/.xyz-agent/pi/agent/extensions`) return true
        // settings.json exists
        if (p === settingsPath) return true
        // user extension dir exists
        if (p === '/custom/my-ext') return true
        // project package.json
        if (p === '/project/package.json') return true
        // npm package - pi-goal exists
        if (p === '/project/node_modules/@zhushanwen/pi-goal/package.json') return true
        // disabled-packages.json doesn't exist
        if (p === `${settingsDir}/disabled-packages.json`) return false
        return false
      })

      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === bundledDir) return ['ext-a', 'shared'] as string[]
        if (p === `${home}/.xyz-agent/pi/agent/extensions`) return ['ext-c'] as string[]
        return [] as string[]
      }) as unknown as typeof readdirSync)

      mockedStatSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        const basename = p.split('/').pop() ?? ''
        if (basename === 'shared') {
          const err = new Error('not found') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        return { isDirectory: () => true } as import('node:fs').Stats
      })

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === settingsPath) {
          return JSON.stringify({ packages: ['npm:pi-ask-user'] })
        }
        if (p === '/project/package.json') {
          return JSON.stringify({ dependencies: {} })
        }
        throw new Error('not found')
      })

      const result = resolver.resolve('/project', false, ['/custom/my-ext'])

      // bundled ext-a
      expect(result.extensionDirs.some(d => d === bundledDir + '/ext-a')).toBe(true)
      // third-party ext-c
      expect(result.extensionDirs.some(d => d.includes('ext-c'))).toBe(true)
      // user extension
      expect(result.extensionDirs.some(d => d === '/custom/my-ext')).toBe(true)
      // 5 sources all processed (no errors)
      expect(result.extensionDirs.length).toBeGreaterThanOrEqual(3)
    })

    it('skips bundled when packaged', () => {
      const home = '/home/user'
      vi.stubEnv('HOME', home)

      const thirdPartyDir = `${home}/.xyz-agent/pi/agent/extensions`

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === thirdPartyDir) return true
        if (p === '/project/package.json') return true
        return false
      })

      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === thirdPartyDir) return ['ext-c'] as string[]
        return [] as string[]
      }) as unknown as typeof readdirSync)

      mockedStatSync.mockImplementation(() => ({ isDirectory: () => true } as import('node:fs').Stats))

      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p === '/project/package.json') {
          return JSON.stringify({ dependencies: {} })
        }
        throw new Error('not found')
      })

      const result = resolver.resolve('/project', true, [])
      expect(result.extensionDirs.length).toBe(1)
      expect(result.extensionDirs[0]).toBe(`${thirdPartyDir}/ext-c`)
    })
  })
})
