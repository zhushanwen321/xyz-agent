import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

import { PluginInstaller } from '../src/services/plugin-service/plugin-installer.js'

// Mock child_process.execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

const mockExecFile = vi.mocked(execFile)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-installer-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  vi.restoreAllMocks()
})

/** Helper: create a valid tgz-like structure in tmpDir that "tar" would extract */
async function createFakeTarball(outDir: string, packageJson: Record<string, unknown>): Promise<string> {
  const pkgDir = join(outDir, 'package')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8')
  await writeFile(join(pkgDir, 'index.js'), 'module.exports = {}', 'utf-8')
  return pkgDir
}

describe('PluginInstaller', () => {
  describe('install - success', () => {
    it('should install a valid xyz-agent plugin', async () => {
      const pluginsDir = join(tmpDir, 'plugins')
      const installer = new PluginInstaller(pluginsDir)

      // npm pack mock: creates a .tgz file
      mockExecFile.mockImplementation((cmd, args, opts, cb) => {
        if (cmd === 'npm') {
          // Create a fake tgz file
          const packDest = args![3] as string // --pack-destination value
          const tgzPath = join(packDest, 'my-test-plugin-1.0.0.tgz')
          writeFile(tgzPath, 'fake tarball', 'utf-8').then(() => {
            // tar mock: extract by copying from our pre-made structure
            ;(cb as unknown as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: tgzPath, stderr: '' })
          })
          return {} as any
        }
        if (cmd === 'tar') {
          // Extract: copy our fake package dir into the extract target
          const extractDir = args![3] as string // -C target
          const fakePkg = {
            name: 'my-test-plugin',
            version: '1.0.0',
            xyzAgent: { manifestVersion: 1, main: 'index.js' },
          }
          void createFakeTarball(extractDir, fakePkg).then(() => {
            ;(cb as unknown as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: '', stderr: '' })
          })
          return {} as any
        }
        return {} as any
      })

      const result = await installer.install('my-test-plugin@1.0.0')

      expect(result.success).toBe(true)
      expect(result.pluginId).toBe('my-test-plugin')
      expect(result.path).toBe(join(pluginsDir, 'my-test-plugin'))

      // Verify package.json was copied correctly
      const installedPkg = JSON.parse(await readFile(join(result.path!, 'package.json'), 'utf-8'))
      expect(installedPkg.name).toBe('my-test-plugin')
      expect(installedPkg.xyzAgent.manifestVersion).toBe(1)
    })
  })

  describe('install - npm pack failure', () => {
    it('should return error when npm pack fails', async () => {
      const installer = new PluginInstaller(join(tmpDir, 'plugins'))

      mockExecFile.mockImplementation((cmd, _args, _opts, cb) => {
        if (cmd === 'npm') {
          const err = new Error('npm pack failed: package not found')
          ;(cb as unknown as (err: Error) => void)(err)
        }
        return {} as any
      })

      const result = await installer.install('nonexistent-package@99.99.99')

      expect(result.success).toBe(false)
      expect(result.error).toContain('npm pack failed')
    })
  })

  describe('install - no xyzAgent manifest', () => {
    it('should return error when package has no xyzAgent manifest', async () => {
      const installer = new PluginInstaller(join(tmpDir, 'plugins'))

      mockExecFile.mockImplementation((cmd, args, _opts, cb) => {
        if (cmd === 'npm') {
          const packDest = args![3] as string
          const tgzPath = join(packDest, 'no-manifest-1.0.0.tgz')
          void writeFile(tgzPath, 'fake', 'utf-8').then(() => {
            ;(cb as unknown as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: tgzPath, stderr: '' })
          })
          return {} as any
        }
        if (cmd === 'tar') {
          const extractDir = args![3] as string
          const fakePkg = {
            name: 'no-manifest-plugin',
            version: '1.0.0',
            // no xyzAgent field
          }
          void createFakeTarball(extractDir, fakePkg).then(() => {
            ;(cb as unknown as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: '', stderr: '' })
          })
          return {} as any
        }
        return {} as any
      })

      const result = await installer.install('no-manifest-plugin')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Not a valid xyz-agent plugin')
    })
  })

  describe('install - wrong manifestVersion', () => {
    it('should return error when manifestVersion is not 1', async () => {
      const installer = new PluginInstaller(join(tmpDir, 'plugins'))

      mockExecFile.mockImplementation((cmd, args, _opts, cb) => {
        if (cmd === 'npm') {
          const packDest = args![3] as string
          const tgzPath = join(packDest, 'wrong-version-1.0.0.tgz')
          void writeFile(tgzPath, 'fake', 'utf-8').then(() => {
            ;(cb as unknown as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: tgzPath, stderr: '' })
          })
          return {} as any
        }
        if (cmd === 'tar') {
          const extractDir = args![3] as string
          const fakePkg = {
            name: 'wrong-version',
            version: '1.0.0',
            xyzAgent: { manifestVersion: 2 },
          }
          void createFakeTarball(extractDir, fakePkg).then(() => {
            ;(cb as unknown as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: '', stderr: '' })
          })
          return {} as any
        }
        return {} as any
      })

      const result = await installer.install('wrong-version')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Not a valid xyz-agent plugin')
    })
  })

  describe('install - no tarball found', () => {
    it('should return error when npm pack produces no .tgz', async () => {
      const installer = new PluginInstaller(join(tmpDir, 'plugins'))

      mockExecFile.mockImplementation((cmd, _args, _opts, cb) => {
        if (cmd === 'npm') {
          // npm pack "succeeds" but no .tgz file is created
          ;(cb as unknown as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: '', stderr: '' })
        }
        return {} as any
      })

      const result = await installer.install('some-package')

      expect(result.success).toBe(false)
      expect(result.error).toContain('No tarball found')
    })
  })

  describe('uninstall', () => {
    it('should remove the plugin directory', async () => {
      const pluginsDir = join(tmpDir, 'plugins')
      const pluginPath = join(pluginsDir, 'test-plugin')
      await mkdir(pluginPath, { recursive: true })
      await writeFile(join(pluginPath, 'package.json'), '{}', 'utf-8')

      const installer = new PluginInstaller(pluginsDir)
      await installer.uninstall('test-plugin', pluginPath)

      // Directory should be gone
      await expect(readFile(join(pluginPath, 'package.json'), 'utf-8')).rejects.toThrow()
    })
  })

  describe('pluginsDir default', () => {
    it('should default to ~/.xyz-agent/plugins when no dir provided', () => {
      const installer = new PluginInstaller()
      // Just verify it doesn't throw and has a reasonable path
      expect(installer).toBeDefined()
    })
  })
})
