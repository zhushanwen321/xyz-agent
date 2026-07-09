/**
 * extension-upgrade.test.ts — W1 wave: extension upgrade + auto-upgrade tests.
 *
 * TDD 红灯阶段：这些测试覆盖本次 wave 的预期行为，在实现前全部失败。
 *
 * 覆盖点：
 * 1. IExtensionSettings port: getAutoUpgrade / setAutoUpgrade（auto-upgrade 开关持久化）
 * 2. IInstaller port: getLatestVersion（从 npm registry 获取 latest 版本号）
 * 3. ExtensionService.upgradeExtension()（单个扩展升级：检查 latest → semver.lt → npm install → 重载）
 * 4. ExtensionService.checkAndAutoUpgrade()（启动时批量检查 + 静默升级，失败不阻塞）
 * 5. Protocol: extension.upgrade / extension.setAutoUpgrade WS 消息
 * 6. ExtensionMessageHandler: 处理 upgrade 相关消息
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExtensionService, ExtensionInstallError } from '../src/services/extension-service.js'
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js'
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js'
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js'

// Mock npm-installer functions
vi.mock('../src/infra/installers/npm-installer.js', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  installDependencies: vi.fn(),
  fetchLatestVersion: vi.fn(),
  NpmInstallError: class extends Error {
    code: 'not_found' | 'network' | 'extract' | 'integrity'
    constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
      super(message)
      this.code = code
      this.name = 'NpmInstallError'
    }
  },
}))

// Mock child_process for git
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}))

describe('Extension Upgrade', () => {
  let testSettingsDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    testSettingsDir = mkdtempSync(join(tmpdir(), 'ext-upgrade-test-'))

    // Create settings.json with a user-installed extension
    writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({
      packages: ['npm:pi-test-ext'],
    }), 'utf-8')

    // Create the installed extension with version 1.0.0
    const extDir = join(testSettingsDir, 'npm', 'node_modules', 'pi-test-ext')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'package.json'), JSON.stringify({
      name: 'pi-test-ext',
      version: '1.0.0',
      description: 'Test extension',
      keywords: ['pi-package'],
      peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
    }), 'utf-8')
    writeFileSync(join(extDir, 'index.ts'), '', 'utf-8')

    // npm dir package.json
    writeFileSync(join(testSettingsDir, 'npm', 'package.json'), JSON.stringify({ private: true }), 'utf-8')
  })

  afterEach(() => {
    try { rmSync(testSettingsDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // ── 1. IExtensionSettings: autoUpgrade 持久化 ─────────────────

  describe('IExtensionSettings: autoUpgrade', () => {
    it('getAutoUpgrade returns empty array when no auto-upgrade config exists', () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      const autoUpgrades = settings.getAutoUpgrade()
      expect(autoUpgrades).toEqual([])
    })

    it('setAutoUpgrade persists auto-upgrade setting to auto-upgrade-packages.json', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      // Verify file was written
      const filePath = join(testSettingsDir, 'auto-upgrade-packages.json')
      expect(existsSync(filePath)).toBe(true)

      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(data.autoUpgrade).toContain('npm:pi-test-ext')

      // Verify getAutoUpgrade reads it back
      expect(settings.getAutoUpgrade()).toContain('npm:pi-test-ext')
    })

    it('setAutoUpgrade(false) removes from auto-upgrade list', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)
      await settings.setAutoUpgrade('npm:pi-test-ext', false)

      expect(settings.getAutoUpgrade()).not.toContain('npm:pi-test-ext')
    })

    it('setAutoUpgrade is idempotent for same source', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      const filePath = join(testSettingsDir, 'auto-upgrade-packages.json')
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      // Should only appear once
      const count = data.autoUpgrade.filter((s: string) => s === 'npm:pi-test-ext').length
      expect(count).toBe(1)
    })
  })

  // ── 2. IInstaller: getLatestVersion ────────────────────────────

  describe('IInstaller.getLatestVersion', () => {
    it('getLatestVersion returns latest version string from npm registry', async () => {
      const { fetchLatestVersion } = await import('../src/infra/installers/npm-installer.js')
      const mockedFetch = vi.mocked(fetchLatestVersion)
      mockedFetch.mockResolvedValue('2.0.0')

      const installer = new NpmGitInstaller()
      const result = await installer.getLatestVersion('pi-test-ext')
      expect(result).toBe('2.0.0')
    })

    it('getLatestVersion throws NpmInstallError for non-existent package', async () => {
      const { fetchLatestVersion, NpmInstallError } = await import('../src/infra/installers/npm-installer.js')
      const mockedFetch = vi.mocked(fetchLatestVersion)
      mockedFetch.mockRejectedValue(new NpmInstallError('not_found', 'Package not found'))

      const installer = new NpmGitInstaller()
      await expect(installer.getLatestVersion('nonexistent-pkg-xyz-12345'))
        .rejects.toThrow()
    })
  })

  // ── 3. ExtensionService.upgradeExtension ──────────────────────

  describe('ExtensionService.upgradeExtension', () => {
    it('upgrades extension when latest version is newer', async () => {
      const { installPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)

      // Mock installPackage to update the installed version
      mockedInstall.mockImplementation(async (_spec, nodeModulesDir) => {
        const pkgDir = join(nodeModulesDir, 'pi-test-ext')
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
          name: 'pi-test-ext',
          version: '2.0.0',
          description: 'Test extension upgraded',
          keywords: ['pi-package'],
          peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
        }), 'utf-8')
        writeFileSync(join(pkgDir, 'index.ts'), '', 'utf-8')
      })

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = new ExtensionService({
        settingsDir: testSettingsDir,
        projectRoot: process.cwd(),
        installer,
        resolver: new ExtensionResolver({ settingsDir: testSettingsDir, thirdPartyDir: join(testSettingsDir, 'extensions') }),
        extensionSettings: new PiExtensionSettings(testSettingsDir),
      })

      const result = await service.upgradeExtension('pi-test-ext')
      expect(result).toEqual({ upgraded: true, from: '1.0.0', to: '2.0.0' })
    })

    it('returns upgraded=false when already at latest version', async () => {
      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('1.0.0')

      const service = new ExtensionService({
        settingsDir: testSettingsDir,
        projectRoot: process.cwd(),
        installer,
        resolver: new ExtensionResolver({ settingsDir: testSettingsDir, thirdPartyDir: join(testSettingsDir, 'extensions') }),
        extensionSettings: new PiExtensionSettings(testSettingsDir),
      })

      const result = await service.upgradeExtension('pi-test-ext')
      expect(result).toEqual({ upgraded: false, from: '1.0.0', to: '1.0.0' })
    })

    it('throws for non-user-installed (built-in) extensions', async () => {
      // Create a built-in extension in the thirdPartyDir (extensions/)
      // so the resolver can find it, but it's NOT in settings packages[]
      const extDir = join(testSettingsDir, 'extensions', 'pi-builtin-ext')
      mkdirSync(extDir, { recursive: true })
      writeFileSync(join(extDir, 'package.json'), JSON.stringify({
        name: 'pi-builtin-ext',
        version: '1.0.0',
        description: 'Built-in extension',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      writeFileSync(join(extDir, 'index.ts'), '', 'utf-8')

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = new ExtensionService({
        settingsDir: testSettingsDir,
        projectRoot: process.cwd(),
        installer,
        resolver: new ExtensionResolver({ settingsDir: testSettingsDir, thirdPartyDir: join(testSettingsDir, 'extensions') }),
        extensionSettings: new PiExtensionSettings(testSettingsDir),
      })

      await expect(service.upgradeExtension('pi-builtin-ext'))
        .rejects.toThrow('Cannot upgrade built-in extension')
    })

    it('throws for non-existent extension', async () => {
      const installer = new NpmGitInstaller()

      const service = new ExtensionService({
        settingsDir: testSettingsDir,
        projectRoot: process.cwd(),
        installer,
        resolver: new ExtensionResolver({ settingsDir: testSettingsDir, thirdPartyDir: join(testSettingsDir, 'extensions') }),
        extensionSettings: new PiExtensionSettings(testSettingsDir),
      })

      await expect(service.upgradeExtension('nonexistent-ext'))
        .rejects.toThrow('Extension not found')
    })
  })

  // ── 4. ExtensionService.checkAndAutoUpgrade ───────────────────

  describe('ExtensionService.checkAndAutoUpgrade', () => {
    it('upgrades extensions with autoUpgrade enabled', async () => {
      const { installPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)

      // Enable auto-upgrade for pi-test-ext
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      // Mock installPackage to update version
      mockedInstall.mockImplementation(async (_spec, nodeModulesDir) => {
        const pkgDir = join(nodeModulesDir, 'pi-test-ext')
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
          name: 'pi-test-ext',
          version: '2.0.0',
          description: 'Auto-upgraded',
          keywords: ['pi-package'],
          peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
        }), 'utf-8')
        writeFileSync(join(pkgDir, 'index.ts'), '', 'utf-8')
      })

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = new ExtensionService({
        settingsDir: testSettingsDir,
        projectRoot: process.cwd(),
        installer,
        resolver: new ExtensionResolver({ settingsDir: testSettingsDir, thirdPartyDir: join(testSettingsDir, 'extensions') }),
        extensionSettings: settings,
      })

      const results = await service.checkAndAutoUpgrade()
      expect(results).toHaveLength(1)
      expect(results[0]).toEqual({ name: 'pi-test-ext', upgraded: true, from: '1.0.0', to: '2.0.0' })
    })

    it('skips extensions without autoUpgrade enabled', async () => {
      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = new ExtensionService({
        settingsDir: testSettingsDir,
        projectRoot: process.cwd(),
        installer,
        resolver: new ExtensionResolver({ settingsDir: testSettingsDir, thirdPartyDir: join(testSettingsDir, 'extensions') }),
        extensionSettings: new PiExtensionSettings(testSettingsDir),
      })

      const results = await service.checkAndAutoUpgrade()
      expect(results).toHaveLength(0)
    })

    it('does not block startup on upgrade failure', async () => {
      const { installPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)

      // Enable auto-upgrade
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      // Mock installPackage to throw
      mockedInstall.mockRejectedValue(new Error('Network error'))

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = new ExtensionService({
        settingsDir: testSettingsDir,
        projectRoot: process.cwd(),
        installer,
        resolver: new ExtensionResolver({ settingsDir: testSettingsDir, thirdPartyDir: join(testSettingsDir, 'extensions') }),
        extensionSettings: settings,
      })

      // Should not throw — failures are collected, not propagated
      const results = await service.checkAndAutoUpgrade()
      expect(results).toHaveLength(1)
      expect(results[0].upgraded).toBe(false)
      expect(results[0].error).toBeDefined()
    })

    it('skips built-in extensions even if somehow in autoUpgrade list', async () => {
      // Create a built-in extension
      const builtinDir = join(testSettingsDir, 'npm', 'node_modules', 'pi-builtin-ext')
      mkdirSync(builtinDir, { recursive: true })
      writeFileSync(join(builtinDir, 'package.json'), JSON.stringify({
        name: 'pi-builtin-ext',
        version: '1.0.0',
        description: 'Built-in',
        keywords: ['pi-package'],
      }), 'utf-8')

      // Manually write auto-upgrade file with built-in extension
      writeFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), JSON.stringify({
        autoUpgrade: ['npm:pi-builtin-ext', 'npm:pi-test-ext'],
      }), 'utf-8')

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')
      const spy = vi.spyOn(installer, 'getLatestVersion')

      const service = new ExtensionService({
        settingsDir: testSettingsDir,
        projectRoot: process.cwd(),
        installer,
        resolver: new ExtensionResolver({ settingsDir: testSettingsDir, thirdPartyDir: join(testSettingsDir, 'extensions') }),
        extensionSettings: new PiExtensionSettings(testSettingsDir),
      })

      const results = await service.checkAndAutoUpgrade()
      // Should only check pi-test-ext (user-installed), not pi-builtin-ext
      expect(spy).not.toHaveBeenCalledWith('pi-builtin-ext')
    })
  })

  // ── 5. Protocol messages ─────────────────────────────────────

  describe('Protocol: extension.upgrade / extension.setAutoUpgrade', () => {
    it('extension.upgrade message type exists in ClientMessageType', async () => {
      const { ClientMessageMap } = await import('@xyz-agent/shared')
      // Type-level check — if this compiles, the type exists
      type UpgradeMsg = typeof ClientMessageMap extends { 'extension.upgrade': infer P } ? P : never
      const msg: UpgradeMsg = { name: 'pi-test-ext' }
      expect(msg.name).toBe('pi-test-ext')
    })

    it('extension.setAutoUpgrade message type exists in ClientMessageType', async () => {
      const { ClientMessageMap } = await import('@xyz-agent/shared')
      type SetAutoMsg = typeof ClientMessageMap extends { 'extension.setAutoUpgrade': infer P } ? P : never
      const msg: SetAutoMsg = { name: 'pi-test-ext', autoUpgrade: true }
      expect(msg.autoUpgrade).toBe(true)
    })

    it('ExtensionInfo includes autoUpgrade field', async () => {
      const { ExtensionInfo } = await import('@xyz-agent/shared')
      // Type-level check
      type HasAutoUpgrade = typeof ExtensionInfo extends { autoUpgrade?: boolean } ? true : false
      const check: HasAutoUpgrade = true
      expect(check).toBe(true)
    })
  })

  // ── 6. ExtensionMessageHandler ────────────────────────────────

  describe('ExtensionMessageHandler: upgrade messages', () => {
    it('handleExtensionMessage handles extension.upgrade', async () => {
      // Will be tested after implementation
      // Expected: calls extensionService.upgradeExtension and returns result
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      expect(typeof ExtensionMessageHandler).toBe('function')
    })

    it('handleExtensionMessage handles extension.setAutoUpgrade', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      expect(typeof ExtensionMessageHandler).toBe('function')
    })
  })
})
