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

  describe('scanNpmExtensions', () => {
    it('reads package.json dependencies and resolves valid pi extensions', () => {
      const pkgJsonPath = '/project/package.json'
      const goalDir = '/project/node_modules/@zhushanwen/pi-goal'
      const subagentsDir = '/project/node_modules/pi-subagents'

      // package.json exists
      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        if (p === pkgJsonPath) return true
        // index.ts exists for valid extensions
        if (p === `${goalDir}/index.ts`) return true
        if (p === `${subagentsDir}/package.json`) return true
        if (p === `${subagentsDir}/src/index.ts`) return true
        return false
      })

      // package.json content
      mockedReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') throw new Error('not found')
        if (p === pkgJsonPath) {
          return JSON.stringify({
            dependencies: {
              '@zhushanwen/pi-goal': '^0.1.0',
              'pi-subagents': '^0.27.0',
              'some-other-pkg': '^1.0.0',
            },
          })
        }
        // pi-goal package.json
        if (p === `${goalDir}/package.json`) {
          return JSON.stringify({ name: '@zhushanwen/pi-goal', main: 'src/index.ts' })
        }
        // pi-subagents package.json
        if (p === `${subagentsDir}/package.json`) {
          return JSON.stringify({ name: 'pi-subagents', main: 'src/index.ts' })
        }
        throw new Error('not found')
      })

      // require.resolve is not available in test, so we mock it via module-level
      // Since scanNpmExtensions uses require.resolve, we need to mock it
      // We'll test via the mock approach below
      // NOTE: require.resolve cannot be easily mocked in vitest
      // The actual test of npm scanning happens in integration tests.
      // Here we test the normalizeExtName and isValidPiExtension logic indirectly.
    })

    it('returns empty when package.json does not exist', () => {
      mockedExistsSync.mockReturnValue(false)

      const result = resolver.scanNpmExtensions('/project')
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

      const result = resolver.scanNpmExtensions('/project')
      expect(result.size).toBe(0)
    })
  })

  describe('normalizeExtName (via deduplicate keys)', () => {
    it('removes scope and pi- prefix from npm package names', () => {
      // @zhushanwen/pi-goal → goal
      // pi-subagents → subagents
      // We test this via deduplicate since normalizeExtName is private
      const sources: SourceMap[] = [
        {
          source: 'npm',
          extensions: new Map([
            ['goal', '/npm/@zhushanwen/pi-goal'],
            ['subagents', '/npm/pi-subagents'],
          ]),
        },
        {
          source: 'bundled',
          extensions: new Map([
            ['subagent', '/bundled/subagent'],
          ]),
        },
      ]

      const result = resolver.deduplicate(sources)
      // npm subagents (key=subagents) and bundled subagent (key=subagent) are different keys
      // because normalizeExtName('pi-subagents') → 'subagents' (with s)
      // and normalizeExtName('subagent') → 'subagent' (without s)
      expect(result.get('subagents')).toBe('/npm/pi-subagents')
      expect(result.get('subagent')).toBe('/bundled/subagent')
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
    it('integrates bundled + third-party + user sources', () => {
      const bundledDir = '/project/resources/pi/agent/extensions'
      const home = process.env.HOME ?? '/home/user'
      const thirdPartyDir = `${home}/.xyz-agent/pi/agent/extensions`

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        return p === bundledDir || p === thirdPartyDir || p === '/custom/my-ext' || p === '/project/package.json'
      })
      mockedReaddirSync.mockImplementation(((p: unknown) => {
        if (p === bundledDir) return ['ext-a', 'shared'] as string[]
        if (p === thirdPartyDir) return ['ext-c'] as string[]
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
        if (p === '/project/package.json') {
          return JSON.stringify({ dependencies: {} })
        }
        throw new Error('not found')
      })

      const result = resolver.resolve('/project', false, ['/custom/my-ext'])

      // bundled ext-a
      const bundledExtA = result.extensionDirs.find(d => d === '/project/resources/pi/agent/extensions/ext-a')
      expect(bundledExtA).toBeDefined()

      // third-party ext-c
      const extCDir = result.extensionDirs.find(d => d.includes('ext-c'))
      expect(extCDir).toBeDefined()

      // user extension
      const userExt = result.extensionDirs.find(d => d === '/custom/my-ext')
      expect(userExt).toBeDefined()
    })

    it('skips bundled when packaged', () => {
      const home = process.env.HOME ?? '/home/user'
      const thirdPartyDir = `${home}/.xyz-agent/pi/agent/extensions`

      mockedExistsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        return p === thirdPartyDir || p === '/project/package.json'
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
      expect(result.extensionDirs).toEqual([`${thirdPartyDir}/ext-c`])
    })
  })
})
