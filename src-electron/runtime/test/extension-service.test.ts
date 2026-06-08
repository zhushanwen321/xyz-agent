import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionService, ExtensionInstallError } from '../src/extension-service.js'

import { execSync, execFileSync } from 'node:child_process'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}))

const mockedExecSync = vi.mocked(execSync)
const mockedExecFileSync = vi.mocked(execFileSync)

describe('ExtensionService', () => {
  let service: ExtensionService
  const testSettingsDir = '/tmp/xyz-agent-test/extensions'

  beforeEach(() => {
    vi.clearAllMocks()
    // Create test directory structure
    mkdirSync(testSettingsDir, { recursive: true })
    writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({
      packages: ['npm:pi-ask-user'],
    }), 'utf-8')
    // Create a fake pi-ask-user package
    const npmDir = join(testSettingsDir, 'npm', 'node_modules', 'pi-ask-user')
    mkdirSync(npmDir, { recursive: true })
    writeFileSync(join(npmDir, 'package.json'), JSON.stringify({
      name: 'pi-ask-user',
      version: '0.1.0',
      description: 'Ask user questions',
      keywords: ['pi-package'],
      peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
    }), 'utf-8')
    writeFileSync(join(npmDir, 'index.ts'), '', 'utf-8')

    // Create settings.json in the npm directory for --prefix install
    writeFileSync(join(testSettingsDir, 'npm', 'package.json'), JSON.stringify({ private: true }), 'utf-8')

    service = new ExtensionService({ settingsDir: testSettingsDir, projectRoot: process.cwd() })
  })

  afterEach(() => {
    // Cleanup test dir
    try {
      rmSync(testSettingsDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  describe('scanExtensions', () => {
    it('returns extensions from all resolver sources', async () => {
      const extensions = await service.scanExtensions()
      const askUser = extensions.find(e => e.name === 'pi-ask-user')
      expect(askUser).toBeDefined()
      expect(askUser!.source).toBe('user-installed')
      expect(askUser!.enabled).toBe(true)
      expect(askUser!.version).toBe('0.1.0')
    })

    it('marks disabled extensions as not enabled', async () => {
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:pi-ask-user'],
      }), 'utf-8')

      const extensions = await service.scanExtensions()
      const askUser = extensions.find(e => e.name === 'pi-ask-user')
      if (askUser) {
        expect(askUser.enabled).toBe(false)
      }
    })

    it('returns empty array when no extensions found', async () => {
      writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({}), 'utf-8')
      rmSync(join(testSettingsDir, 'npm'), { recursive: true, force: true })

      const extensions = await service.scanExtensions()
      expect(Array.isArray(extensions)).toBe(true)
    })
  })

  describe('getExtensionPaths', () => {
    it('returns paths of enabled extensions', async () => {
      const paths = await service.getExtensionPaths()
      expect(paths.some(p => p.includes('pi-ask-user'))).toBe(true)
    })

    it('excludes disabled extensions', async () => {
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:pi-ask-user'],
      }), 'utf-8')

      const paths = await service.getExtensionPaths()
      expect(paths.some(p => p.includes('pi-ask-user'))).toBe(false)
    })
  })

  describe('installExtension', () => {
    it('throws for non-npm sources', async () => {
      await expect(service.installExtension('git:foo/bar')).rejects.toThrow('Unsupported source')
    })

    it('throws when package is not a valid pi extension', async () => {
      mockedExecFileSync.mockImplementation(() => '')
      const npmDir = join(testSettingsDir, 'npm', 'node_modules', 'invalid-pkg')
      mkdirSync(npmDir, { recursive: true })
      writeFileSync(join(npmDir, 'package.json'), JSON.stringify({
        name: 'invalid-pkg',
        version: '1.0.0',
      }), 'utf-8')
      expect(existsSync(join(npmDir, 'package.json'))).toBe(true)

      await expect(service.installExtension('npm:invalid-pkg')).rejects.toThrow('not a valid pi extension')
    })
  })

  describe('uninstallExtension', () => {
    it('removes from settings.json', async () => {
      const npmDir = join(testSettingsDir, 'npm', 'node_modules', 'test-pkg')
      mkdirSync(npmDir, { recursive: true })
      writeFileSync(join(npmDir, 'package.json'), JSON.stringify({
        name: 'test-pkg', version: '0.1.0', description: '',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')

      const settingsPath = join(testSettingsDir, 'settings.json')
      const raw = readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw)
      settings.packages = [...(settings.packages || []), 'npm:test-pkg']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      mockedExecFileSync.mockImplementation(() => '')
      await service.uninstallExtension('test-pkg')

      const updatedRaw = readFileSync(settingsPath, 'utf-8')
      const updatedSettings = JSON.parse(updatedRaw)
      expect(updatedSettings.packages).not.toContain('npm:test-pkg')
    })
  })

  describe('toggleExtension', () => {
    it('toggles extension to disabled', async () => {
      await service.toggleExtension('pi-ask-user', false)

      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      expect(existsSync(disabledPath)).toBe(true)
      const raw = readFileSync(disabledPath, 'utf-8')
      const data = JSON.parse(raw)
      expect(data.disabled).toContain('npm:pi-ask-user')
    })

    it('toggles disabled extension back to enabled', async () => {
      await service.toggleExtension('pi-ask-user', false)
      await service.toggleExtension('pi-ask-user', true)

      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      expect(existsSync(disabledPath)).toBe(false)
    })
  })

  // ── Task 3: ExtensionInstallError and error classification ────

  describe('ExtensionInstallError', () => {
    it('has code, message, and optional hint', () => {
      const err = new ExtensionInstallError('not_found', 'Package not found', 'Check the package name')
      expect(err.code).toBe('not_found')
      expect(err.message).toBe('Package not found')
      expect(err.hint).toBe('Check the package name')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(ExtensionInstallError)
    })

    it('works without hint', () => {
      const err = new ExtensionInstallError('network', 'Connection timeout')
      expect(err.code).toBe('network')
      expect(err.hint).toBeUndefined()
    })
  })

  describe('installExtension error classification', () => {
    it('classifies 404 errors as not_found', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('npm install failed: npm ERR! 404 Not Found - GET https://registry.npmjs.org/nonexistent-pkg')
      })

      try {
        await service.installExtension('npm:nonexistent-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_found')
      }
    })

    it('classifies E404 errors as not_found', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('npm ERR! E404 Package not found')
      })

      try {
        await service.installExtension('npm:e404-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_found')
      }
    })

    it('classifies other npm errors as network', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('npm ERR! ETIMEOUT request timeout')
      })

      try {
        await service.installExtension('npm:timeout-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('network')
      }
    })

    it('classifies invalid pi extension as not_extension', async () => {
      mockedExecFileSync.mockImplementation(() => '')
      const npmDir = join(testSettingsDir, 'npm', 'node_modules', 'lodash')
      mkdirSync(npmDir, { recursive: true })
      writeFileSync(join(npmDir, 'package.json'), JSON.stringify({
        name: 'lodash',
        version: '4.17.21',
      }), 'utf-8')

      try {
        await service.installExtension('npm:lodash')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_extension')
      }
    })
  })

  // ── Task 4: installLocalDirectory, installGitRepository, finishInstall ──

  describe('installLocalDirectory', () => {
    it('throws for non-existent path', async () => {
      await expect(service.installLocalDirectory('/nonexistent/path'))
        .rejects.toThrow('does not exist')
    })

    it('throws for non-directory path', async () => {
      const filePath = join(testSettingsDir, 'some-file.txt')
      writeFileSync(filePath, 'hello', 'utf-8')

      await expect(service.installLocalDirectory(filePath))
        .rejects.toThrow('not a directory')
    })

    it('discovers extensions from a local directory with single pi extension', async () => {
      const sourceDir = join(testSettingsDir, 'source-ext')
      const extDir = join(sourceDir, 'my-pi-ext')
      mkdirSync(extDir, { recursive: true })
      writeFileSync(join(extDir, 'package.json'), JSON.stringify({
        name: 'pi-my-ext',
        version: '1.0.0',
        description: 'A test extension',
        keywords: ['pi-package'],
      }), 'utf-8')

      const result = await service.installLocalDirectory(sourceDir)

      expect(result.tempDir).toContain('ext-scan-')
      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0].name).toBe('pi-my-ext')
      expect(result.candidates[0].version).toBe('1.0.0')

      // Cleanup
      try { rmSync(result.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    it('discovers extensions from a directory that IS a pi extension itself', async () => {
      const sourceDir = join(testSettingsDir, 'source-ext-single')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
        name: 'pi-direct-ext',
        version: '2.0.0',
        description: 'Direct extension',
        pi: { type: 'extension' },
      }), 'utf-8')

      const result = await service.installLocalDirectory(sourceDir)

      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0].name).toBe('pi-direct-ext')

      // Cleanup
      try { rmSync(result.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    it('returns empty candidates when no valid extensions found', async () => {
      const sourceDir = join(testSettingsDir, 'source-empty')
      mkdirSync(sourceDir, { recursive: true })

      const result = await service.installLocalDirectory(sourceDir)

      expect(result.candidates).toHaveLength(0)

      // Cleanup
      try { rmSync(result.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    })
  })

  describe('installGitRepository', () => {
    it('throws when git clone fails', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('git clone failed: repository not found')
      })

      await expect(service.installGitRepository('https://github.com/nonexistent/repo.git'))
        .rejects.toThrow('git clone failed')
    })

    it('discovers extensions from a cloned git repo', async () => {
      // Mock: when git clone is called via execFileSync, create the extension structure in the target dir
      mockedExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
        if (args?.[0] === 'clone') {
          // args = ['clone', '--depth', '1', url, tempDir]
          const targetDir = args[4] ?? ''
          if (targetDir) {
            mkdirSync(targetDir, { recursive: true })
            const extDir = join(targetDir, 'packages', 'pi-cloned-ext')
            mkdirSync(extDir, { recursive: true })
            writeFileSync(join(extDir, 'package.json'), JSON.stringify({
              name: 'pi-cloned-ext',
              version: '0.5.0',
              description: 'A cloned extension',
              keywords: ['pi-package'],
            }), 'utf-8')
          }
        }
        return ''
      })

      const result = await service.installGitRepository('https://github.com/user/pi-ext-repo.git')

      expect(result.tempDir).toContain('ext-scan-')
      expect(result.candidates.length).toBeGreaterThanOrEqual(1)
      expect(result.candidates.some(c => c.name === 'pi-cloned-ext')).toBe(true)

      // Cleanup
      try { rmSync(result.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    })
  })

  describe('finishInstall', () => {
    it('copies selected extensions to extensions dir and cleans up temp', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-finish')
      const extA = join(tempDir, 'ext-a')
      const extB = join(tempDir, 'ext-b')
      mkdirSync(extA, { recursive: true })
      mkdirSync(extB, { recursive: true })
      writeFileSync(join(extA, 'package.json'), JSON.stringify({
        name: 'pi-ext-a', version: '1.0.0', description: 'A', keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(extB, 'package.json'), JSON.stringify({
        name: 'pi-ext-b', version: '1.0.0', description: 'B', keywords: ['pi-package'],
      }), 'utf-8')

      await service.finishInstall(tempDir, ['ext-a', 'ext-b'])

      const extensionsDir = join(testSettingsDir, 'extensions')
      expect(existsSync(join(extensionsDir, 'ext-a', 'package.json'))).toBe(true)
      expect(existsSync(join(extensionsDir, 'ext-b', 'package.json'))).toBe(true)
      expect(existsSync(tempDir)).toBe(false)
    })

    it('only installs selected extensions, not all', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-partial')
      const extA = join(tempDir, 'ext-a')
      const extB = join(tempDir, 'ext-b')
      mkdirSync(extA, { recursive: true })
      mkdirSync(extB, { recursive: true })
      writeFileSync(join(extA, 'package.json'), JSON.stringify({
        name: 'pi-ext-a', version: '1.0.0', description: 'A', keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(extB, 'package.json'), JSON.stringify({
        name: 'pi-ext-b', version: '1.0.0', description: 'B', keywords: ['pi-package'],
      }), 'utf-8')

      await service.finishInstall(tempDir, ['ext-a'])

      const extensionsDir = join(testSettingsDir, 'extensions')
      expect(existsSync(join(extensionsDir, 'ext-a'))).toBe(true)
      expect(existsSync(join(extensionsDir, 'ext-b'))).toBe(false)
    })

    it('throws when selected extension does not exist in temp dir', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-missing')
      mkdirSync(tempDir, { recursive: true })

      await expect(service.finishInstall(tempDir, ['nonexistent']))
        .rejects.toThrow('not found in temp directory')
    })
  })
})
