import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Task 4 tests: ExtensionService — scan, toggle, getEnabled, getExtensionPaths.
 *
 * Uses real temp directories with mocked fs operations where needed.
 * Tests the black-list state model (extension-state.json: { disabled: string[] }).
 */

// ── Mock fs/promises ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fs mock needs any for flexible call signatures
const mockFs: Record<string, any> = {
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
}

vi.mock('node:fs/promises', () => ({
  readdir: (...args: unknown[]) => mockFs.readdir(...args),
  readFile: (...args: unknown[]) => mockFs.readFile(...args),
  writeFile: (...args: unknown[]) => mockFs.writeFile(...args),
  rename: (...args: unknown[]) => mockFs.rename(...args),
  mkdir: (...args: unknown[]) => mockFs.mkdir(...args),
  access: (...args: unknown[]) => mockFs.access(...args),
}))

import { ExtensionService } from '../src/extension-service.js'

// ── Helpers ───────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), 'xyz-agent-ext-test')

function makePackageJson(name: string, version = '1.0.0', description = `Test extension ${name}`) {
  return JSON.stringify({ name, version, description })
}

// ── Tests ─────────────────────────────────────────────────────────

describe('ExtensionService', () => {
  let service: ExtensionService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new ExtensionService(TEST_DIR)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── scanExtensions ───────────────────────────────────────────────

  describe('scanExtensions', () => {
    it('returns empty array when extensions dir does not exist (readdir throws ENOENT)', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException
      enoent.code = 'ENOENT'
      mockFs.readdir.mockRejectedValue(enoent)

      const result = await service.scanExtensions()

      expect(result).toEqual([])
    })

    it('returns empty array when extensions dir is empty', async () => {
      mockFs.readdir.mockResolvedValue([])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":[]}')
        return Promise.reject(new Error('not found'))
      })

      const result = await service.scanExtensions()

      expect(result).toEqual([])
    })

    it('skips subdirs without package.json', async () => {
      mockFs.readdir.mockResolvedValue(['ext-a', 'ext-b'])
      // ext-a has package.json, ext-b doesn't
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('ext-a/package.json')) return Promise.resolve(makePackageJson('ext-a'))
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":[]}')
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        return Promise.reject(err)
      })

      const result = await service.scanExtensions()

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('ext-a')
    })

    it('reads package.json fields correctly', async () => {
      mockFs.readdir.mockResolvedValue(['my-ext'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('my-ext/package.json')) return Promise.resolve(makePackageJson('my-ext', '2.1.0', 'A cool extension'))
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":[]}')
        return Promise.reject(new Error('not found'))
      })

      const result = await service.scanExtensions()

      expect(result).toEqual([
        {
          name: 'my-ext',
          version: '2.1.0',
          description: 'A cool extension',
          path: join(TEST_DIR, 'my-ext'),
          enabled: true,
        },
      ])
    })

    it('marks extension as disabled when in disabled list', async () => {
      mockFs.readdir.mockResolvedValue(['ext-a', 'ext-b'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('ext-a/package.json')) return Promise.resolve(makePackageJson('ext-a'))
        if (p.includes('ext-b/package.json')) return Promise.resolve(makePackageJson('ext-b'))
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":["ext-b"]}')
        return Promise.reject(new Error('not found'))
      })

      const result = await service.scanExtensions()

      expect(result).toHaveLength(2)
      expect(result.find(e => e.name === 'ext-a')?.enabled).toBe(true)
      expect(result.find(e => e.name === 'ext-b')?.enabled).toBe(false)
    })

    it('treats missing state file as all-enabled', async () => {
      mockFs.readdir.mockResolvedValue(['ext-a'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('ext-a/package.json')) return Promise.resolve(makePackageJson('ext-a'))
        if (p.includes('extension-state.json')) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          return Promise.reject(err)
        }
        return Promise.reject(new Error('not found'))
      })

      const result = await service.scanExtensions()

      expect(result).toHaveLength(1)
      expect(result[0].enabled).toBe(true)
    })

    it('skips subdirs with invalid JSON package.json', async () => {
      mockFs.readdir.mockResolvedValue(['bad-ext'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('bad-ext/package.json')) return Promise.resolve('not json{{{')
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":[]}')
        return Promise.reject(new Error('not found'))
      })

      const result = await service.scanExtensions()

      expect(result).toEqual([])
    })

    it('handles package.json missing name field', async () => {
      mockFs.readdir.mockResolvedValue(['no-name'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('no-name/package.json')) return Promise.resolve('{"version":"1.0.0"}')
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":[]}')
        return Promise.reject(new Error('not found'))
      })

      const result = await service.scanExtensions()

      // name defaults to directory name
      expect(result).toEqual([
        {
          name: 'no-name',
          version: '1.0.0',
          description: '',
          path: join(TEST_DIR, 'no-name'),
          enabled: true,
        },
      ])
    })

    it('handles package.json missing version and description', async () => {
      mockFs.readdir.mockResolvedValue(['minimal'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('minimal/package.json')) return Promise.resolve('{"name":"minimal"}')
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":[]}')
        return Promise.reject(new Error('not found'))
      })

      const result = await service.scanExtensions()

      expect(result).toEqual([
        {
          name: 'minimal',
          version: '',
          description: '',
          path: join(TEST_DIR, 'minimal'),
          enabled: true,
        },
      ])
    })
  })

  // ── getEnabledExtensions ─────────────────────────────────────────

  describe('getEnabledExtensions', () => {
    it('returns only enabled extensions', async () => {
      mockFs.readdir.mockResolvedValue(['ext-a', 'ext-b', 'ext-c'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('ext-a/package.json')) return Promise.resolve(makePackageJson('ext-a'))
        if (p.includes('ext-b/package.json')) return Promise.resolve(makePackageJson('ext-b'))
        if (p.includes('ext-c/package.json')) return Promise.resolve(makePackageJson('ext-c'))
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":["ext-b"]}')
        return Promise.reject(new Error('not found'))
      })

      const result = await service.getEnabledExtensions()

      expect(result).toHaveLength(2)
      expect(result.map(e => e.name)).toEqual(['ext-a', 'ext-c'])
    })

    it('returns empty when all disabled', async () => {
      mockFs.readdir.mockResolvedValue(['ext-a'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('ext-a/package.json')) return Promise.resolve(makePackageJson('ext-a'))
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":["ext-a"]}')
        return Promise.reject(new Error('not found'))
      })

      const result = await service.getEnabledExtensions()

      expect(result).toEqual([])
    })
  })

  // ── toggleExtension ──────────────────────────────────────────────

  describe('toggleExtension', () => {
    it('enables a previously disabled extension', async () => {
      // Initial state: ext-b is disabled
      mockFs.readFile.mockResolvedValue('{"disabled":["ext-b"]}')
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.rename.mockResolvedValue(undefined)

      await service.toggleExtension('ext-b', true)

      // Should write updated state with ext-b removed from disabled
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1)
      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string
      const parsed = JSON.parse(writtenContent)
      expect(parsed.disabled).toEqual([])
    })

    it('disables a previously enabled extension', async () => {
      mockFs.readFile.mockResolvedValue('{"disabled":[]}')
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.rename.mockResolvedValue(undefined)

      await service.toggleExtension('ext-a', false)

      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string
      const parsed = JSON.parse(writtenContent)
      expect(parsed.disabled).toEqual(['ext-a'])
    })

    it('silently ignores enabling an already-enabled extension', async () => {
      mockFs.readFile.mockResolvedValue('{"disabled":[]}')
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.rename.mockResolvedValue(undefined)

      await service.toggleExtension('ext-a', true)

      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string
      const parsed = JSON.parse(writtenContent)
      expect(parsed.disabled).toEqual([])
    })

    it('silently ignores disabling an already-disabled extension', async () => {
      mockFs.readFile.mockResolvedValue('{"disabled":["ext-a"]}')
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.rename.mockResolvedValue(undefined)

      await service.toggleExtension('ext-a', false)

      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string
      const parsed = JSON.parse(writtenContent)
      expect(parsed.disabled).toEqual(['ext-a'])
    })

    it('creates state file when it does not exist', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException
      enoent.code = 'ENOENT'
      // First call (readFile) fails with ENOENT
      mockFs.readFile.mockRejectedValue(enoent)
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.rename.mockResolvedValue(undefined)
      mockFs.mkdir.mockResolvedValue(undefined)

      await service.toggleExtension('ext-new', false)

      // Should create the directory and write default + toggle
      expect(mockFs.mkdir).toHaveBeenCalled()
      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string
      const parsed = JSON.parse(writtenContent)
      expect(parsed.disabled).toEqual(['ext-new'])
    })

    it('uses atomic write (writeFile + rename)', async () => {
      mockFs.readFile.mockResolvedValue('{"disabled":[]}')
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.rename.mockResolvedValue(undefined)

      await service.toggleExtension('ext-a', false)

      // writeFile to temp file, then rename to real file
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1)
      expect(mockFs.rename).toHaveBeenCalledTimes(1)
      const tempPath = mockFs.writeFile.mock.calls[0][0] as string
      const finalPath = mockFs.rename.mock.calls[0][1] as string
      expect(tempPath).toContain('.tmp')
      expect(finalPath).toContain('extension-state.json')
    })
  })

  // ── getExtensionPaths ────────────────────────────────────────────

  describe('getExtensionPaths', () => {
    it('returns absolute paths of enabled extensions', async () => {
      mockFs.readdir.mockResolvedValue(['ext-a', 'ext-b'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('ext-a/package.json')) return Promise.resolve(makePackageJson('ext-a'))
        if (p.includes('ext-b/package.json')) return Promise.resolve(makePackageJson('ext-b'))
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":["ext-b"]}')
        return Promise.reject(new Error('not found'))
      })

      const paths = await service.getExtensionPaths()

      expect(paths).toEqual([join(TEST_DIR, 'ext-a')])
    })

    it('returns empty array when no extensions', async () => {
      mockFs.readdir.mockResolvedValue([])

      const paths = await service.getExtensionPaths()

      expect(paths).toEqual([])
    })

    it('returns empty array when all disabled', async () => {
      mockFs.readdir.mockResolvedValue(['ext-a'])
      mockFs.readFile.mockImplementation((path: string | Buffer | URL) => {
        const p = path.toString()
        if (p.includes('ext-a/package.json')) return Promise.resolve(makePackageJson('ext-a'))
        if (p.includes('extension-state.json')) return Promise.resolve('{"disabled":["ext-a"]}')
        return Promise.reject(new Error('not found'))
      })

      const paths = await service.getExtensionPaths()

      expect(paths).toEqual([])
    })
  })
})
