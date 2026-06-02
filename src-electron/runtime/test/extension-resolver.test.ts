import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ExtensionResolver } from '../src/extension-resolver.js'
import type { SourceMap } from '../src/extension-resolver.js'

// Mock node:fs and node:path
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock('node:path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
}))

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'

const mockedExistsSync = vi.mocked(existsSync)
const mockedReaddirSync = vi.mocked(readdirSync)
const mockedStatSync = vi.mocked(statSync)
const mockedReadFileSync = vi.mocked(readFileSync)

function mockDir(path: string): void {
  mockedExistsSync.mockImplementation((p: unknown) => {
    if (typeof p !== 'string') return false
    return p === path || p.startsWith(path + '/')
  })
  mockedReaddirSync.mockImplementation(((p: unknown) => {
    if (p === path) return ['ext-a', 'ext-b', 'shared']
    return []
  }) as unknown as typeof readdirSync)
  mockedStatSync.mockImplementation((p: unknown) => {
    if (typeof p !== 'string') throw new Error('not found')
    const basename = p.split('/').pop() ?? ''
    if (basename === 'shared' || !p.startsWith(path)) {
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

  describe('scanNpmExtensions', () => {
    it('discovers pi-* packages and uses short name as key', () => {
      const scopeDir = '/project/node_modules/@zhushanwen'
      mockedExistsSync.mockImplementation((p: unknown) => typeof p === 'string' && p === scopeDir)
      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === scopeDir) return ['pi-code-review', 'pi-something', 'not-pi-pkg'] as string[]
        return [] as string[]
      }) as unknown as typeof readdirSync)
      mockedStatSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        const basename = p.split('/').pop() ?? ''
        if (basename === 'not-pi-pkg') throw new Error('not dir')
        return { isDirectory: () => true } as import('node:fs').Stats
      })
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p.includes('pi-code-review')) {
          return JSON.stringify({ name: '@zhushanwen/pi-code-review' })
        }
        if (p.includes('pi-something')) {
          return JSON.stringify({ name: '@zhushanwen/pi-something' })
        }
        throw new Error('not found')
      })

      const result = resolver.scanNpmExtensions('/project')
      expect(result.size).toBe(2)
      // key 是短名（不带 @zhushanwen/ scope），与 bundled/third-party 一致
      expect(result.get('pi-code-review')).toBe('/project/node_modules/@zhushanwen/pi-code-review')
      expect(result.get('pi-something')).toBe('/project/node_modules/@zhushanwen/pi-something')
    })


    it('includes all pi-* packages regardless of package.json fields', () => {
      const scopeDir = '/project/node_modules/@zhushanwen'
      mockedExistsSync.mockImplementation((p: unknown) => typeof p === 'string' && p === scopeDir)
      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === scopeDir) return ['pi-review'] as string[]
        return [] as string[]
      }) as unknown as typeof readdirSync)
      mockedStatSync.mockImplementation(() => ({ isDirectory: () => true } as import('node:fs').Stats))
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.includes('pi-review')) {
          return JSON.stringify({ name: '@zhushanwen/pi-review' })
        }
        throw new Error('not found')
      })

      const result = resolver.scanNpmExtensions('/project')
      expect(result.size).toBe(1)
      expect(result.get('pi-review')).toBe('/project/node_modules/@zhushanwen/pi-review')
    })


    it('returns empty when node_modules/@zhushanwen does not exist', () => {
      mockedExistsSync.mockReturnValue(false)

      const result = resolver.scanNpmExtensions('/project')
      expect(result.size).toBe(0)
    })
  })

  describe('scanBundledExtensions', () => {
    it('scans bundled directory in dev mode', () => {
      mockDir('/project/resources/pi/agent/extensions')

      const result = resolver.scanBundledExtensions('/project', false)
      expect(result.size).toBe(2) // ext-a, ext-b (shared skipped)
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
          extensions: new Map([
            ['ext-a', '/npm/ext-a'],
          ]),
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
      // npm (high priority) should win for ext-a
      expect(result.get('ext-a')).toBe('/npm/ext-a')
      // bundled only has ext-b
      expect(result.get('ext-b')).toBe('/bundled/ext-b')
    })

    it('npm overrides bundled for same name', () => {
      const sources: SourceMap[] = [
        {
          source: 'bundled',
          extensions: new Map([['review', '/bundled/review']]),
        },
        {
          source: 'npm',
          extensions: new Map([['review', '/npm/review']]),
        },
      ]

      const result = resolver.deduplicate(sources)
      expect(result.get('review')).toBe('/npm/review')
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
    it('integrates all sources and deduplicates', () => {
      // Mock: bundled dir exists with ext-a
      const bundledDir = '/project/resources/pi/agent/extensions'
      const home = process.env.HOME ?? '/home/user'
      const thirdPartyDir = `${home}/.xyz-agent/pi/agent/extensions`

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        return p === bundledDir || p === thirdPartyDir || p === '/custom/my-ext' || p === '/project/node_modules/@zhushanwen'
      })
      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === bundledDir) return ['ext-a', 'shared'] as string[]
        if (p === thirdPartyDir) return ['ext-c'] as string[]
        if (p === '/project/node_modules/@zhushanwen') return ['pi-ext-a'] as string[]
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
        if (p.includes('pi-ext-a')) {
          return JSON.stringify({ name: '@zhushanwen/pi-ext-a' })
        }
        throw new Error('not found')
      })

      const result = resolver.resolve('/project', false, ['/custom/my-ext'])

      // npm's pi-ext-a should be included
      const npmExtA = result.extensionDirs.find(d => d.includes('pi-ext-a'))
      expect(npmExtA).toBeDefined()

      // bundled ext-a (different name from npm's pi-ext-a) should also be included
      const bundledExtA = result.extensionDirs.find(d => d === '/project/resources/pi/agent/extensions/ext-a')
      expect(bundledExtA).toBeDefined()

      // third-party ext-c should be included
      const extCDir = result.extensionDirs.find(d => d.includes('ext-c'))
      expect(extCDir).toBeDefined()

      // user extension should be included
      const userExt = result.extensionDirs.find(d => d === '/custom/my-ext')
      expect(userExt).toBeDefined()
    })

    it('skips bundled when packaged', () => {
      const home = process.env.HOME ?? '/home/user'
      const thirdPartyDir = `${home}/.xyz-agent/pi/agent/extensions`

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        return p === thirdPartyDir
      })
      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === thirdPartyDir) return ['ext-c'] as string[]
        return [] as string[]
      }) as unknown as typeof readdirSync)
      mockedStatSync.mockImplementation(() => ({ isDirectory: () => true } as import('node:fs').Stats))

      const result = resolver.resolve('/project', true, [])
      // No bundled scan, no npm scan, only third-party
      expect(result.extensionDirs).toEqual([`${thirdPartyDir}/ext-c`])
    })
  })
})
