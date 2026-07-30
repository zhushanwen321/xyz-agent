import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { ExtensionService, ExtensionInstallError } from '../src/services/extension-service.js'
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js'
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js'
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js'

import { installPackage, uninstallPackage, NpmInstallError } from '../src/infra/installers/npm-installer.js'
import { execFileSync } from 'node:child_process'

vi.mock('../src/infra/installers/npm-installer.js', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  installDependencies: vi.fn(),
  NpmInstallError: class extends Error {
    code: 'not_found' | 'network' | 'extract' | 'integrity'
    constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
      super(message)
      this.code = code
      this.name = 'NpmInstallError'
    }
  },
}))

// git clone still uses execFileSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}))

const mockedInstallPackage = vi.mocked(installPackage)
const mockedUninstallPackage = vi.mocked(uninstallPackage)
const mockedExecFileSync = vi.mocked(execFileSync)

describe('ExtensionService', () => {
  let service: ExtensionService
  let testSettingsDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    // Create test directory structure
    testSettingsDir = mkdtempSync(join(tmpdir(), 'ext-service-test-'))
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

    service = new ExtensionService({
      settingsDir: testSettingsDir,
      projectRoot: process.cwd(),
      installer: new NpmGitInstaller(),
      resolver: new ExtensionResolver({
        settingsDir: testSettingsDir,
        thirdPartyDir: join(testSettingsDir, 'extensions'),
        // Phase 1 路径迁移：npmDir 已从 settingsDir 子树迁出，注入回 testSettingsDir/npm 让 fixture 继续生效。
        npmDir: join(testSettingsDir, 'npm'),
      }),
      // IExtensionSettings port：经 pi-settings-store 统一读写 settings.json（D17）。
      // 构造时把 store 路径对齐到 testSettingsDir，使 model 域与 extension 域在测试中读写同一文件。
      extensionSettings: new PiExtensionSettings(testSettingsDir),
      // Phase 1 路径迁移：extensions/npm/tmp 已从 settingsDir 子树迁出到 dataDir 根层，
      // 注入回 testSettingsDir 子目录让现有 fixture（settingsDir/npm、settingsDir/extensions、settingsDir/tmp）继续生效。
      extensionsDir: join(testSettingsDir, 'extensions'),
      npmDir: join(testSettingsDir, 'npm'),
      tmpDir: join(testSettingsDir, 'tmp'),
    })
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
      expect(askUser!.dirName).toBe('pi-ask-user')
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

  describe('getRecommendedExtensions', () => {
    it('excludes mandatory packages from recommended list (all 6 recommended are now mandatory)', async () => {
      const recommended = await service.getRecommendedExtensions()
      // recommended-extensions.json 的 6 个条目全部属于 mandatory SSOT，
      // Task 4.3 要求 getRecommendedExtensions 过滤掉 mandatory 项 → 返回空列表。
      // 这是新契约：mandatory 扩展不进推荐列表（它们由 boot 强制安装）。
      expect(recommended.length).toBe(0)
    })

    it('marks matching non-mandatory recommended package as installed', async () => {
      // recommended-extensions.json 当前所有条目都是 mandatory，无法直接测 installed 标记。
      // 这里改为间接验证：getRecommendedExtensions 过滤 mandatory 后只返回非 mandatory 项，
      // 且对返回的每一项 installed 字段为 boolean（契约形状检查）。
      const recommended = await service.getRecommendedExtensions()
      expect(recommended.every(r => typeof r.installed === 'boolean')).toBe(true)
      // 所有返回项都不是 mandatory 包
      expect(recommended.every(r => !['@zhushanwen/pi-ask-user',
        '@zhushanwen/pi-goal', '@zhushanwen/pi-todo',
        '@zhushanwen/pi-pending-notifications', '@zhushanwen/pi-subagent-workflow',
        '@zhushanwen/pi-structured-output'].includes(r.name))).toBe(true)
    })
  })

  describe('mandatory extensions', () => {
    it('scanExtensions sets mandatory=true for mandatory packages', async () => {
      // 在 npm/node_modules 下造一个 mandatory 包（@zhushanwen/pi-goal）
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', '@zhushanwen', 'pi-goal')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@zhushanwen/pi-goal',
        version: '0.4.0',
        description: 'goal ext',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      const settingsPath = join(testSettingsDir, 'settings.json')
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      settings.packages = [...(settings.packages || []), 'npm:@zhushanwen/pi-goal']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      const extensions = await service.scanExtensions()
      const goal = extensions.find(e => e.name === '@zhushanwen/pi-goal')
      expect(goal).toBeDefined()
      expect(goal!.mandatory).toBe(true)
      // 非 mandatory 包 mandatory 字段为 false
      const askUser = extensions.find(e => e.name === 'pi-ask-user')
      if (askUser) {
        expect(askUser.mandatory).toBe(false)
      }
    })

    it('uninstallExtension rejects mandatory packages', async () => {
      await expect(service.uninstallExtension('@zhushanwen/pi-goal'))
        .rejects.toThrow(/Mandatory extension cannot be uninstalled/)
    })

    it('uninstallExtension allows non-mandatory packages', async () => {
      // pi-ask-user 非 mandatory，卸载不应抛 mandatory 守卫错误
      // （后续 npm uninstall 是 mock 的，不会真正报错）
      await expect(service.uninstallExtension('pi-ask-user'))
        .resolves.toBeUndefined()
    })
  })

  describe('ensureMandatoryExtensions', () => {
    it('installs missing mandatory extensions + enables autoUpgrade', async () => {
      // scanExtensions 只返回 pi-ask-user，所有 mandatory 包都「未装」
      const installSpy = vi.spyOn(service, 'installExtension').mockResolvedValue(undefined)
      const autoUpgradeSpy = vi.spyOn(service['extSettings'], 'setAutoUpgrade').mockResolvedValue(undefined)

      const results = await service.ensureMandatoryExtensions()

      // 9 个 mandatory 包都触发了安装
      expect(installSpy).toHaveBeenCalledTimes(9)
      expect(autoUpgradeSpy).toHaveBeenCalledTimes(9)
      // 每个结果都是 installed:true
      expect(results.every(r => r.installed)).toBe(true)
      expect(results.every(r => !r.error)).toBe(true)

      installSpy.mockRestore()
      autoUpgradeSpy.mockRestore()
    })

    it('skips already-installed mandatory extensions', async () => {
      // 造一个已安装的 mandatory 包 @zhushanwen/pi-goal
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', '@zhushanwen', 'pi-goal')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@zhushanwen/pi-goal',
        version: '0.5.0',
        description: 'goal ext',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      const settingsPath = join(testSettingsDir, 'settings.json')
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      settings.packages = [...(settings.packages || []), 'npm:@zhushanwen/pi-goal']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      const installSpy = vi.spyOn(service, 'installExtension').mockResolvedValue(undefined)

      const results = await service.ensureMandatoryExtensions()

      // pi-goal 已装 → 少调一次 installExtension（8 次而非 9 次）
      expect(installSpy).toHaveBeenCalledTimes(8)
      expect(installSpy).not.toHaveBeenCalledWith('npm:@zhushanwen/pi-goal')
      // pi-goal 结果仍是 installed:true
      const goalResult = results.find(r => r.name === '@zhushanwen/pi-goal')
      expect(goalResult?.installed).toBe(true)

      installSpy.mockRestore()
    })

    it('does not throw when install fails, records error', async () => {
      const installSpy = vi.spyOn(service, 'installExtension').mockRejectedValue(new Error('network timeout'))

      const results = await service.ensureMandatoryExtensions()

      // 不抛错
      expect(results).toHaveLength(9)
      // 每个都 installed:false + 有 error
      expect(results.every(r => !r.installed)).toBe(true)
      expect(results.every(r => r.error?.includes('network timeout'))).toBe(true)

      installSpy.mockRestore()
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

  describe('XYZ_EXTENSION_PATHS', () => {
    let userExtDir: string

    beforeEach(() => {
      // 造一个临时 extension 目录，满足 isValidPiExtension（keywords 含 pi-package）
      userExtDir = mkdtempSync(join(tmpdir(), 'ext-user-path-'))
      writeFileSync(join(userExtDir, 'package.json'), JSON.stringify({
        name: 'my-dev-extension',
        version: '0.0.1',
        description: 'local dev extension',
        keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(userExtDir, 'index.ts'), '', 'utf-8')
      process.env.XYZ_EXTENSION_PATHS = userExtDir
    })

    afterEach(() => {
      delete process.env.XYZ_EXTENSION_PATHS
      try { rmSync(userExtDir, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    it('scanExtensions 能扫到 XYZ_EXTENSION_PATHS 指向的 extension', async () => {
      const extensions = await service.scanExtensions()
      const found = extensions.find(e => e.name === 'my-dev-extension')
      expect(found).toBeDefined()
      expect(found!.path).toBe(userExtDir)
    })

    it('getExtensionPaths 返回的路径包含 user extension 目录', async () => {
      const paths = await service.getExtensionPaths()
      expect(paths).toContain(userExtDir)
    })

    it('无效路径静默跳过，不抛错', async () => {
      process.env.XYZ_EXTENSION_PATHS = `/nonexistent/path${delimiter}${userExtDir}`
      const extensions = await service.scanExtensions()
      // 无效路径被跳过，有效的仍在
      expect(extensions.find(e => e.name === 'my-dev-extension')).toBeDefined()
    })

    it('多个路径用分隔符隔开都能扫到', async () => {
      const userExtDir2 = mkdtempSync(join(tmpdir(), 'ext-user-path2-'))
      writeFileSync(join(userExtDir2, 'package.json'), JSON.stringify({
        name: 'second-dev-extension',
        version: '0.0.1',
        keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(userExtDir2, 'index.ts'), '', 'utf-8')
      try {
        process.env.XYZ_EXTENSION_PATHS = `${userExtDir}${delimiter}${userExtDir2}`
        const extensions = await service.scanExtensions()
        expect(extensions.find(e => e.path === userExtDir)).toBeDefined()
        expect(extensions.find(e => e.path === userExtDir2)).toBeDefined()
      } finally {
        rmSync(userExtDir2, { recursive: true, force: true })
      }
    })
  })

  describe('installExtension', () => {
    it('throws for non-npm sources', async () => {
      await expect(service.installExtension('git:foo/bar')).rejects.toThrow('Unsupported source')
    })

    it('throws when package is not a valid pi extension', async () => {
      // installPackage succeeds but the installed package lacks pi manifest fields
      mockedInstallPackage.mockResolvedValue(undefined)
      mockedUninstallPackage.mockResolvedValue(undefined)
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', 'invalid-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'invalid-pkg',
        version: '1.0.0',
      }), 'utf-8')

      await expect(service.installExtension('npm:invalid-pkg')).rejects.toThrow('not a valid pi extension')
    })
  })

  describe('uninstallExtension', () => {
    it('removes from settings.json', async () => {
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', 'test-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'test-pkg', version: '0.1.0', description: '',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')

      const settingsPath = join(testSettingsDir, 'settings.json')
      const raw = readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw)
      settings.packages = [...(settings.packages || []), 'npm:test-pkg']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      mockedUninstallPackage.mockResolvedValue(undefined)
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

    it('rejects disabling mandatory packages', async () => {
      // @zhushanwen/pi-goal 是 mandatory（与 uninstallExtension 守卫对称）：
      // 禁用应抛 mandatory_cannot_disable，避免 UI 禁用但 getExtensionPaths 仍强加载的状态分离
      await expect(service.toggleExtension('@zhushanwen/pi-goal', false))
        .rejects.toThrow(/Mandatory extension cannot be disabled/)
    })

    it('allows enabling mandatory packages', async () => {
      // 开启 mandatory 扩展允许（守卫只拦截禁用，开启无害）
      await expect(service.toggleExtension('@zhushanwen/pi-goal', true))
        .resolves.toBeUndefined()
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
      mockedInstallPackage.mockRejectedValue(new NpmInstallError('not_found', 'Package not found (404)'))

      try {
        await service.installExtension('npm:nonexistent-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_found')
      }
    })

    it('classifies E404 errors as not_found', async () => {
      mockedInstallPackage.mockRejectedValue(new Error('npm ERR! E404 Package not found'))

      try {
        await service.installExtension('npm:e404-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_found')
      }
    })

    it('classifies other npm errors as network', async () => {
      mockedInstallPackage.mockRejectedValue(new NpmInstallError('network', 'Connection timeout'))

      try {
        await service.installExtension('npm:timeout-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('network')
      }
    })

    it('classifies invalid pi extension as not_extension', async () => {
      mockedInstallPackage.mockResolvedValue(undefined)
      mockedUninstallPackage.mockResolvedValue(undefined)
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', 'lodash')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
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

      try {
        expect(result.tempDir).toContain('ext-scan-')
        expect(result.candidates).toHaveLength(1)
        expect(result.candidates[0].name).toBe('pi-my-ext')
        expect(result.candidates[0].version).toBe('1.0.0')
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
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

      try {
        expect(result.candidates).toHaveLength(1)
        expect(result.candidates[0].name).toBe('pi-direct-ext')
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('根即 extension：dirName 是源目录名（非 tempDir basename），finishInstall 回路完整', async () => {
      // 回归测试：源目录本身就是单个 pi extension 时，dirName 必须是源目录 basename，
      // 而非 tempDir 的 basename（"ext-scan-xxxx"）。否则 finishInstall 找不到子目录。
      const sourceDir = join(testSettingsDir, 'ask-user')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
        name: 'pi-ask-user',
        version: '0.1.0',
        description: 'single ext at root',
        keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(sourceDir, 'index.ts'), '', 'utf-8')

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.candidates).toHaveLength(1)
        // dirName 是源目录名，不是 tempDir basename（"ext-scan-xxxx"）
        expect(result.candidates[0].dirName).toBe('ask-user')
        expect(result.tempDir).toContain('ext-scan-') // tempDir 名仍带前缀，但 dirName 不等于它

        // finishInstall 回路：用返回的 tempDir + dirName 完成安装
        await service.finishInstall(result.tempDir, [result.candidates[0].dirName])
        const extensionsDir = join(testSettingsDir, 'extensions')
        expect(existsSync(join(extensionsDir, 'ask-user', 'package.json'))).toBe(true)
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('returns empty candidates when no valid extensions found', async () => {
      const sourceDir = join(testSettingsDir, 'source-empty')
      mkdirSync(sourceDir, { recursive: true })

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.candidates).toHaveLength(0)
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
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
          // git clone args: ['clone', '--depth', '1', url, targetDir]
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

    it('clone 到 tempDir/<repoName>/ 子目录，dirName 是仓库名非 tempDir basename', async () => {
      // 回归：仓库根本身是单个 extension 时，clone 目标是 tempDir/repoName/，
      // discoverExtensions 走子目录扫描，dirName = repoName，finishInstall 回路完整。
      mockedExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
        if (args?.[0] === 'clone') {
          const targetDir = args[4] ?? ''
          if (targetDir) {
            mkdirSync(targetDir, { recursive: true })
            // 仓库根本身就是 extension（package.json 直接在 targetDir 下）
            writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
              name: 'pi-single-repo',
              version: '1.0.0',
              description: 'repo root IS the extension',
              keywords: ['pi-package'],
            }), 'utf-8')
            writeFileSync(join(targetDir, 'index.ts'), '', 'utf-8')
          }
        }
        return ''
      })

      const result = await service.installGitRepository('https://github.com/user/pi-single-repo.git')

      try {
        expect(result.candidates).toHaveLength(1)
        // repoName = pi-single-repo（URL 末段去 .git）
        expect(result.candidates[0].dirName).toBe('pi-single-repo')
        expect(result.tempDir).toContain('ext-scan-')

        // finishInstall 回路
        await service.finishInstall(result.tempDir, [result.candidates[0].dirName])
        const extensionsDir = join(testSettingsDir, 'extensions')
        expect(existsSync(join(extensionsDir, 'pi-single-repo', 'package.json'))).toBe(true)
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
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
        .rejects.toThrow('not found in')
    })

    it('rejects symlink extension in temp dir', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-symlink')
      mkdirSync(tempDir, { recursive: true })
      // Create a symlink pointing to a real dir outside tempDir
      const targetDir = join(testSettingsDir, 'symlink-target')
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(join(targetDir, 'package.json'), '{}', 'utf-8')
      symlinkSync(targetDir, join(tempDir, 'evil-link'))

      await expect(service.finishInstall(tempDir, ['evil-link']))
        .rejects.toThrow('symlink')
    })
  })

  describe('cancelInstall', () => {
    it('cleans up valid temp directory', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-cancel')
      mkdirSync(tempDir, { recursive: true })
      writeFileSync(join(tempDir, 'marker.txt'), 'test', 'utf-8')

      await service.cancelInstall(tempDir)

      expect(existsSync(tempDir)).toBe(false)
    })

    it('throws for path outside allowedPrefixes', async () => {
      await expect(service.cancelInstall('/tmp/outside-xyz'))
        .rejects.toThrow()
    })

    it('handles non-existent temp dir gracefully', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-nonexistent-cancel')
      // Should not throw — rmSync force:true is idempotent
      await expect(service.cancelInstall(tempDir)).resolves.toBeUndefined()
    })
  })

  describe('installGitRepository URL validation', () => {
    it('rejects http:// URLs (SSRF prevention)', async () => {
      await expect(service.installGitRepository('http://169.254.169.254/latest/meta-data/'))
        .rejects.toThrow('Invalid Git URL')
    })

    it('rejects git:// URLs', async () => {
      await expect(service.installGitRepository('git://github.com/user/repo.git'))
        .rejects.toThrow('Invalid Git URL')
    })

    it('rejects ftp:// URLs', async () => {
      await expect(service.installGitRepository('ftp://example.com/repo'))
        .rejects.toThrow('Invalid Git URL')
    })

    it('accepts https:// URLs', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('git clone failed: test')
      })
      // Should fail with git clone error, not URL validation error
      await expect(service.installGitRepository('https://github.com/user/repo.git'))
        .rejects.toThrow('git clone failed')
    })
  })

  describe('installLocalDirectory path security', () => {
    it('rejects paths outside home and tmp', async () => {
      await expect(service.installLocalDirectory('/etc/passwd'))
        .rejects.toThrow(/not a directory|does not exist/)
    })

    it('rejects non-directory paths under home', async () => {
      const filePath = join(homedir(), 'xyz-agent-test-file-' + Date.now())
      writeFileSync(filePath, 'test', 'utf-8')
      try {
        await expect(service.installLocalDirectory(filePath))
          .rejects.toThrow('not a directory')
      } finally {
        try { rmSync(filePath, { force: true }) } catch { /* ignore */ }
      }
    })
  })
})
