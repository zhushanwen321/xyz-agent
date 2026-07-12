/**
 * ExtensionService — 管理 pi extension 生命周期。
 *
 * 使用 ExtensionResolver 做发现，settings.json 管理 packages[]，
 * disabled-packages.json 管理启用/禁用状态。
 *
 * 支持三种安装来源：
 * - npm install（npm:xxx）
 * - 本地目录扫描（installLocalDirectory）
 * - Git 仓库克隆扫描（installGitRepository）
 *
 * 本地/Git 安装流程：
 * 1. 复制/克隆到临时目录 tmp/ext-scan-{ts}
 * 2. discoverExtensions() 递归扫描有效 pi 扩展
 * 3. 前端展示候选列表，用户选择
 * 4. finishInstall() 复制选中到 extensions/ 目录
 * 5. 清理临时目录
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync, realpathSync, cpSync, rmSync, mkdtempSync } from 'node:fs'
import { join, resolve, basename, delimiter } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { ExtensionInfo } from '@xyz-agent/shared'
import { recommendedExtensions } from '@xyz-agent/shared'
import semver from 'semver'
import type { IInstaller, IExtensionResolver } from './ports/installer.js'
import type { IExtensionSettings } from './ports/extension-settings.js'
import { isStrictlyUnder, isUnderOrEqual, extractRepoName } from '../utils/path-utils.js'
import { toErrorMessage } from '../utils/errors.js'
import { isPackaged, getExtensionFilePath } from '../utils/runtime-env.js'

const log = {
  info: (...args: unknown[]) => console.log('[extension-service]', ...args),
  warn: (...args: unknown[]) => console.warn('[extension-service]', ...args),
  error: (...args: unknown[]) => console.error('[extension-service]', ...args),
   
  debug: (..._args: unknown[]) => { /* no-op in production */ },
}

const NPM_PREFIX_LENGTH = 4 // "npm:" 前缀长度
const NPM_INSTALL_TIMEOUT = 60_000
const GIT_CLONE_TIMEOUT = 120_000
const DISCOVERY_TEMP_PREFIX = 'ext-scan-'
// eslint-disable-next-line no-magic-numbers
const ORPHAN_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours
const ALLOWED_GIT_PREFIXES = ['https://', 'ssh://', 'git@'] as const

// ── Error classes ─────────────────────────────────────────────────

/**
 * ExtensionInstallError — classified npm install errors.
 *
 * code values:
 * - 'not_found'    — 404/E404 from npm registry
 * - 'network'      — generic npm failure (timeout, permissions, etc.)
 * - 'not_extension' — npm install succeeded but not a valid pi extension
 */
export class ExtensionInstallError extends Error {
  readonly code: string
  readonly hint?: string

  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'ExtensionInstallError'
    this.code = code
    this.hint = hint
  }
}

export interface ExtensionServiceOptions {
  /** Agent 配置目录（~/.xyz-agent/pi/agent，由 index.ts 经 configStore 注入） */
  settingsDir: string
  /** 项目根目录（用于 resolver npm 扫描） */
  projectRoot?: string
  /** 是否打包模式 */
  packaged?: boolean
  /** 安装器 port（npm + git），由 index.ts 注入 */
  installer: IInstaller
  /** 扩展解析器 port，由 index.ts 注入 */
  resolver: IExtensionResolver
  /**
   * 扩展配置 port（settings.json packages[] + disabled-packages.json），由 index.ts 注入。
   * 经此 port 读写 settings.json，不再直接 readFileSync/writeFileSync（D17 收口）。
   */
  extensionSettings: IExtensionSettings
}

export class ExtensionService {
  private readonly settingsDir: string
  private readonly installer: IInstaller
  private readonly resolver: IExtensionResolver
  private readonly extSettings: IExtensionSettings
  private readonly projectRoot: string
  private readonly packaged: boolean

  /** 文件型 extension 路径（如 xyz-agent-extension.js），打包/开发模式不同 */
  private extensionFilePath: string

  /** npm install 串行锁——多个扩展共享同一 --prefix 目录（~/.xyz-agent/pi/agent/npm/），
   * npm 不支持对同一 prefix 的并发安装，并发会损坏 node_modules。
   * 所有写操作（install/uninstall/upgrade/autoUpgrade）走此锁串行化。 */
  private installChain: Promise<void> = Promise.resolve()
  private withInstallLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.installChain.then(fn)
    // 吞掉错误使链不断裂（错误由调用方处理）
    this.installChain = result.then(() => undefined, () => undefined)
    return result
  }

  constructor(options: ExtensionServiceOptions) {
    this.settingsDir = options.settingsDir
    this.installer = options.installer
    this.resolver = options.resolver
    this.extSettings = options.extensionSettings
    this.projectRoot = options.projectRoot ?? process.cwd()
    this.packaged = options.packaged ?? isPackaged()

    // 文件型 extension 路径
    this.extensionFilePath = getExtensionFilePath(this.projectRoot, this.packaged)

    // Cleanup orphaned temp directories from previous crashes (>24h old)
    // Defer to next tick to avoid blocking constructor
    setTimeout(() => this.cleanupOrphanedTempDirs(), 0)
  }

  private cleanupOrphanedTempDirs(): void {
    try {
      const tmpDir = join(this.settingsDir, 'tmp')
      if (!existsSync(tmpDir)) return
      const entries = readdirSync(tmpDir)
      const cutoff = Date.now() - ORPHAN_TEMP_MAX_AGE_MS
      for (const entry of entries) {
        if (!entry.startsWith(DISCOVERY_TEMP_PREFIX)) continue
        const fullPath = join(tmpDir, entry)
        try {
          const st = statSync(fullPath)
          if (st.isDirectory() && st.mtimeMs < cutoff) {
            rmSync(fullPath, { recursive: true, force: true })
            log.info(`cleaned orphaned temp dir: ${fullPath}`)
          }
        } catch (e) { log.debug(`failed to check temp dir ${fullPath}: ${toErrorMessage(e)}`) }
      }
    } catch (e) { log.debug(`failed to cleanup orphaned temp dirs: ${toErrorMessage(e)}`) }
  }

  /**
   * 读取 XYZ_EXTENSION_PATHS 环境变量，解析为绝对路径数组。
   * 用于本地开发：指向 extension 源码目录，无需 cp 副本或 npm install。
   * 用 path.delimiter 分隔（POSIX ':' / Windows ';'，与 PATH 约定一致），空值自动过滤。
   * 相对路径基于 projectRoot 解析。路径有效性由 resolver.scanUserExtensions 校验。
   */
  private getUserExtensionPaths(): string[] {
    const raw = process.env.XYZ_EXTENSION_PATHS
    if (!raw) return []
    return raw
      .split(delimiter)
      .map(p => p.trim())
      .filter(p => p.length > 0)
      .map(p => resolve(this.projectRoot, p))
  }

  /**
   * 扫描所有 extension，返回 ExtensionInfo[]。
   * 用 ExtensionResolver 扫描所有源，对 settings 源的扩展读 packages[] 判断启用状态。
   */
  async scanExtensions(): Promise<ExtensionInfo[]> {
    const result = this.resolver.resolve(this.projectRoot, this.packaged, this.getUserExtensionPaths())
    // 读取 settings.json packages[] 用于判断 source 和 enabled
    const { packages, disabled } = this.readSettingsState()
    const disabledSet = new Set(disabled)
    // 读取 auto-upgrade 配置
    const autoUpgradeSet = new Set(this.extSettings.getAutoUpgrade())

    const extensions: ExtensionInfo[] = []

    for (const dir of result.extensionDirs) {
      const pkgJsonPath = join(dir, 'package.json')
      let name = basename(dir)
      let version = ''
      let description = ''

      try {
        const raw = readFileSync(pkgJsonPath, 'utf-8')
        const pkg = JSON.parse(raw) as { name?: string; version?: string; description?: string }
        name = pkg.name ?? name
        version = pkg.version ?? ''
        description = pkg.description ?? ''
      } catch (e) {
        log.debug(`[extension-service] failed to read package.json at ${pkgJsonPath}: ${toErrorMessage(e)}`)
      }

      // 判断 source：路径在 settings packages[] 中则为 user-installed
      const sourceKey = `npm:${name}`
      const isUserInstalled = packages.includes(sourceKey)
      const isDisabled = disabledSet.has(sourceKey)
      const isAutoUpgrade = autoUpgradeSet.has(sourceKey)

      extensions.push({
        name,
        dirName: basename(dir),
        version,
        description,
        path: dir,
        enabled: !isDisabled,
        source: isUserInstalled ? 'user-installed' : 'built-in',
        autoUpgrade: isAutoUpgrade,
      })
    }

    return extensions
  }

  /**
   * 返回推荐扩展列表，附带当前已安装状态。
   *
   * 匹配逻辑：scanExtensions() 拿到已装列表，按 npm 包名精确匹配。
   * ExtensionInfo.name 存的是原始 npm 包名（如 @zhushanwen/pi-goal，见 readPackageJson
   * 的 NOTE 注释——name 故意保留原始值不做 normalize），与 recommended-extensions.json
   * 的 name 字段一致，无需 normalizeExtName 转换。
   *
   * SSOT：recommended-extensions.json（shared 包导出，runtime import）。
   */
  async getRecommendedExtensions(): Promise<Array<{ name: string; description: string; installed: boolean }>> {
    const installed = await this.scanExtensions()
    const installedNames = new Set(installed.map(e => e.name))
    return recommendedExtensions.map(r => ({ ...r, installed: installedNames.has(r.name) }))
  }

  /**
   * 返回启用的 extension 路径列表（供 pi --extension 参数使用）。
   * 封装 ExtensionResolver.resolve() + 过滤禁用项 + 追加文件型 extension。
   */
  async getExtensionPaths(): Promise<string[]> {
    const result = this.resolver.resolve(this.projectRoot, this.packaged, this.getUserExtensionPaths())
    const { disabled } = this.readSettingsState()
    const disabledSet = new Set(disabled)

    // 过滤禁用项
    const filtered = result.extensionDirs.filter(dir => {
      // Use package.json name (not basename) for scoped package support
      let pkgName = basename(dir)
      try {
        const raw = readFileSync(join(dir, 'package.json'), 'utf-8')
        const pkg = JSON.parse(raw) as { name?: string }
        if (pkg.name) pkgName = pkg.name
      } catch {
        log.debug(`[extension-service] getExtensionPaths: failed to read package.json in ${dir}`)
      }
      return !disabledSet.has(`npm:${pkgName}`)
    })

    // 追加文件型 extension
    if (existsSync(this.extensionFilePath)) {
      filtered.push(this.extensionFilePath)
    }

    return filtered
  }

  /**
   * 安装 npm 包 → 写 settings.json packages[] → 返回。
   * 验证 npm 包是否为有效的 pi extension。
   * 失败时抛出 ExtensionInstallError，含 code 和 hint。
   *
   * settings.json 的 RMW 经 IExtensionSettings → pi-settings-store 的异步互斥队列串行化，
   * 杜绝并发安装的 read-modify-write 竞态（D17 收口）。
   */
  async installExtension(source: string): Promise<void> {
    return this.withInstallLock(async () => {
      if (!source.startsWith('npm:')) {
        throw new Error(`Unsupported source: ${source}. Only npm:xxx format is supported.`)
      }

      const pkgName = source.slice(NPM_PREFIX_LENGTH)
      if (!isValidNpmPackageName(pkgName)) {
        throw new ExtensionInstallError('not_found', `Invalid npm package name: ${pkgName}`)
      }
      const npmDir = join(this.settingsDir, 'npm')

      // 确保 npm 目录有 package.json
      if (!existsSync(npmDir)) {
        mkdirSync(npmDir, { recursive: true })
      }
      const pkgJsonPath = join(npmDir, 'package.json')
      if (!existsSync(pkgJsonPath)) {
        writeFileSync(pkgJsonPath, JSON.stringify({ private: true }), 'utf-8')
      }

      // npm install + 错误分类 + isValidPiExtension 验证 + 失败回滚
      await this.installAndValidate(pkgName, npmDir)

      // 写入 settings.json packages[]（经 IExtensionSettings port → pi-settings-store 互斥 RMW）
      await this.extSettings.addPackage(source)
    })
  }

  /**
   * 从 settings.json packages[] 移除 → 清理 disabled-packages.json → npm uninstall。
   * settings 写经 IExtensionSettings port（pi-settings-store 互斥 RMW），disabled 同 port 管理。
   */
  async uninstallExtension(name: string): Promise<void> {
    return this.withInstallLock(async () => {
      const npmDir = join(this.settingsDir, 'npm')
      const source = `npm:${name}`

      // 从 settings packages[] 移除（经 port → pi-settings-store 互斥 RMW）
      await this.extSettings.removePackage(source)

      // 从 disabled-packages.json 清理（经 port）
      await this.extSettings.removeDisabled(source)

      // 从 auto-upgrade-packages 清理（经 port，与 removeDisabled 对称）
      await this.extSettings.removeAutoUpgrade(source)

      // Remove from node_modules (经 IInstaller port)
      const nodeModulesDir = join(npmDir, 'node_modules')
      if (existsSync(npmDir)) {
        try {
          await this.installer.uninstallNpm(name, nodeModulesDir)
        } catch (e) {
          log.warn(`[extension-service] npm uninstall warning for ${name}: ${toErrorMessage(e)}`)
        }
      }
    })
  }

  /**
   * 切换某个包的启用/禁用。
   * 经 IExtensionSettings port 操作 disabled-packages.json。
   */
  async toggleExtension(name: string, enabled: boolean): Promise<void> {
    const source = `npm:${name}`
    await this.extSettings.setEnabled(source, enabled)
  }

  /**
   * 设置某个包的自动升级状态。
   * 经 IExtensionSettings port 操作 auto-upgrade-packages.json。
   */
  async setAutoUpgrade(name: string, autoUpgrade: boolean): Promise<void> {
    const source = `npm:${name}`
    await this.extSettings.setAutoUpgrade(source, autoUpgrade)
  }

  /**
   * 升级单个用户安装的扩展。
   * 检查 npm latest 版本 → semver.lt 判定 → npm install 最新版。
   * 仅 user-installed 扩展可升级，built-in 扩展抛出错误。
   *
   * @returns { upgraded, from, to } 或 { upgraded: false, from, to } 如果已是最新
   */
  async upgradeExtension(
    name: string,
  ): Promise<{ upgraded: boolean; from: string; to: string }> {
    return this.withInstallLock(async () => {
      if (!isValidNpmPackageName(name)) {
        throw new ExtensionInstallError('not_found', `Invalid npm package name: ${name}`)
      }
      // 校验包存在且是 user-installed
      const extensions = await this.scanExtensions()
      const ext = extensions.find(e => e.name === name)
      if (!ext) {
        throw new ExtensionInstallError('not_installed', `Extension not installed: ${name}`)
      }
      if (ext.source !== 'user-installed') {
        throw new ExtensionInstallError(
          'not_user_installed',
          `Built-in extensions cannot be upgraded: ${name}`,
          'Built-in extensions are managed by the application and do not support upgrade.',
        )
      }

      const currentVersion = ext.version
      const latestVersion = await this.installer.getLatestVersion(name)

      // semver.lt 判定：currentVersion 为空（semver.valid=null）或 >= latest 则无需升级
      if (!currentVersion || !semver.valid(currentVersion) || !semver.lt(currentVersion, latestVersion)) {
        return { upgraded: false, from: currentVersion, to: latestVersion }
      }

      // 执行升级：npm install 最新版（复用 installExtension 的错误分类 + isValidPiExtension 验证）
      const npmDir = join(this.settingsDir, 'npm')
      await this.installAndValidate(name, npmDir, 'upgrade')

      // 从 node_modules/<name>/package.json 读取实际安装版本，
      // 避免因 TOCTOU 与 registry dist-tags.latest 不一致
      const actualVersion = this.readInstalledVersion(name, npmDir)
      return { upgraded: true, from: currentVersion, to: actualVersion || latestVersion }
    })
  }

  /**
   * 启动时批量检查并自动升级开启了 autoUpgrade 的扩展。
   * 失败不阻塞启动——每个扩展的升级错误被捕获并记录，不影响其他扩展。
   *
   * @returns 每个扩展的升级结果（含成功/失败信息）
   */
  async checkAndAutoUpgrade(): Promise<Array<{ name: string; upgraded: boolean; from?: string; to?: string; error?: string }>> {
    const autoUpgradeSources = this.extSettings.getAutoUpgrade()
    if (autoUpgradeSources.length === 0) return []

    const extensions = await this.scanExtensions()
    const results: Array<{ name: string; upgraded: boolean; from?: string; to?: string; error?: string }> = []

    // 串行执行是有意为之：多个 extension 的 npm install 共享同一个 --prefix 目录
    // （~/.xyz-agent/pi/agent/npm/），npm 不支持对同一 prefix 的并发安装，
    // 并发会导致 node_modules 损坏。故不能改成 Promise.allSettled 并发。
    // 注：此处不自行加锁——每次 upgradeExtension 自身走 withInstallLock，
    // 既序列化了本次 auto-upgrade 内部的多次升级，也与外部并发调用（install/uninstall/upgrade）互斥。
    for (const source of autoUpgradeSources) {
      // 只处理 npm: 前缀的 user-installed 扩展
      if (!source.startsWith('npm:')) continue
      const pkgName = source.slice(NPM_PREFIX_LENGTH)

      // 查找扩展——不存在或 built-in 则跳过
      const ext = extensions.find(e => e.name === pkgName)
      if (!ext || ext.source !== 'user-installed') continue

      try {
        const result = await this.upgradeExtension(pkgName)
        results.push({ name: pkgName, ...result })
      } catch (e) {
        // 失败不阻塞启动——记录错误继续处理其他扩展
        log.warn(`[extension-service] auto-upgrade failed for ${pkgName}: ${toErrorMessage(e)}`)
        results.push({ name: pkgName, upgraded: false, error: toErrorMessage(e) })
      }
    }

    return results
  }

  // ── Local / Git install methods ────────────────────────────────

  /**
   * Install from a local directory path.
   * Copies to temp dir, discovers extensions, returns candidates.
   */
  async installLocalDirectory(sourcePath: string): Promise<{ tempDir: string; candidates: ExtensionInfo[] }> {
    const absPath = resolve(sourcePath)

    if (!existsSync(absPath)) {
      throw new Error(`Source path does not exist: ${absPath}`)
    }

    // Use lstatSync to detect symlinks — resolve real target for path whitelist
    const st = lstatSync(absPath)
    const checkPath = st.isSymbolicLink() ? resolve(realpathSync(absPath)) : absPath

    // Reuse stat result — for symlinks, statSync gives target's type
    if (!st.isDirectory() && !st.isSymbolicLink()) {
      throw new Error(`Source path is not a directory: ${absPath}`)
    }
    // For symlinks, verify the target is also a directory
    if (st.isSymbolicLink() && !statSync(checkPath).isDirectory()) {
      throw new Error(`Source path is not a directory: ${absPath}`)
    }

    // Restrict source path to safe directories (home or os.tmpdir())
    // Check resolved path to prevent symlink bypass
    const homeDir = homedir()
    const sysTmpDir = tmpdir()
    if (!isUnderOrEqual(homeDir, checkPath) && !isUnderOrEqual(sysTmpDir, checkPath)) {
      throw new Error(`Source path must be under home directory or /tmp`)
    }

    // Ensure tmp parent directory exists
    const tmpParent = join(this.settingsDir, 'tmp')
    mkdirSync(tmpParent, { recursive: true })

    // Create temp directory
    const tempDir = mkdtempSync(join(tmpParent, DISCOVERY_TEMP_PREFIX))

    // Copy into tempDir/<sourceBaseName>/ — not tempDir root. When the source IS itself
    // a pi extension, discoverExtensions returns dirName = basename(scanned dir). Copying
    // to a named subdir keeps dirName = sourceBaseName, matching finishInstall's contract
    // (selected names must be tempDir subdirectories). Otherwise dirName becomes the
    // tempDir basename ("ext-scan-xxxx") and finishInstall fails.
    const sourceBaseName = basename(checkPath)
    const destInTemp = join(tempDir, sourceBaseName)

    try {
      cpSync(checkPath, destInTemp, { recursive: true })
      const candidates = this.discoverExtensions(tempDir)
      return { tempDir, candidates }
    } catch (err) {
      rmSync(tempDir, { recursive: true, force: true })
      throw err
    }
  }

  /**
   * Install from a Git repository URL.
   * Clones to temp dir, optionally runs npm install, discovers extensions.
   */
  async installGitRepository(url: string): Promise<{ tempDir: string; candidates: ExtensionInfo[] }> {
    // Ensure tmp parent directory exists
    const tmpParent = join(this.settingsDir, 'tmp')
    mkdirSync(tmpParent, { recursive: true })

    // Create temp directory
    const tempDir = mkdtempSync(join(tmpParent, DISCOVERY_TEMP_PREFIX))

    // Validate Git URL format
    if (!ALLOWED_GIT_PREFIXES.some(p => url.startsWith(p))) {
      throw new Error(`Invalid Git URL: ${url}. Must start with one of: ${ALLOWED_GIT_PREFIXES.join(', ')}`)
    }

    // Clone into tempDir/<repoName>/ — same rationale as installLocalDirectory: avoids
    // the "root IS the extension" case where dirName would become the tempDir basename.
    const repoName = extractRepoName(url)
    const destInTemp = join(tempDir, repoName)

    // Git clone — 经 IInstaller port（infra spawn git，execFileSync 防 command injection）
    try {
      await this.installer.installGit(url, destInTemp, GIT_CLONE_TIMEOUT)
    } catch (e) {
      const msg = toErrorMessage(e)
      // Cleanup temp dir on failure
      try { rmSync(tempDir, { recursive: true, force: true }) } catch (cleanupErr) {
        log.warn('[extension-service] failed to cleanup temp dir:', cleanupErr)
      }
      throw new Error(`git clone failed: ${msg}`)
    }

    // If package.json exists, install dependencies (经 IInstaller port)
    if (existsSync(join(destInTemp, 'package.json'))) {
      try {
        await this.installer.installDeps(destInTemp)
      } catch (e) {
        log.warn(`[extension-service] npm install in git repo failed: ${toErrorMessage(e)}`)
        // Non-fatal — some repos don't need deps to discover extensions
      }
    }

    // Discover extensions — wrap in try-catch to clean up tempDir on unexpected errors
    try {
      const candidates = this.discoverExtensions(tempDir)
      return { tempDir, candidates }
    } catch (err) {
      try { rmSync(tempDir, { recursive: true, force: true }) } catch (e) { log.debug('cleanup failed:', toErrorMessage(e)) }
      throw err
    }
  }

  /**
   * Finish installation: copy selected extensions from temp dir to extensions/ directory.
   * Cleans up temp dir after copying.
   * @param selected - Array of dirName values (filesystem basenames) from discovered candidates.
   *   NOT npm package names — scoped packages have dirName = basename(dir).
   *   NOTE: Two scoped packages with same leaf name (e.g. @foo/bar and @baz/bar) will
   *   collide since both resolve to dirName='bar'. This is an accepted limitation.
   */
  async finishInstall(tempDir: string, selected: string[]): Promise<void> {
    // Validate tempDir is within settingsDir/tmp
    const resolvedTemp = resolve(tempDir)
    const allowedTmpPrefix = resolve(this.settingsDir, 'tmp')
    if (!isStrictlyUnder(allowedTmpPrefix, resolvedTemp)) {
      throw new Error(`Invalid temp directory: ${tempDir}`)
    }

    // Validate selected are simple dirNames: no path traversal
    // NOTE: `selected` contains dirName values (filesystem basenames), not npm package names.
    // scoped packages like @scope/pkg have dirName = 'pkg' (or whatever basename returns).
    for (const dirName of selected) {
      if (dirName !== basename(dirName) || dirName.includes('..') || dirName.includes('/') || dirName.includes('\\')) {
        throw new Error(`Invalid extension dirName: "${dirName}"`
          + ' — must be a simple directory name without path separators or traversal')
      }
    }

    // Pre-validate all source directories exist before copying
    // Use lstatSync to reject symlinks — tempDir entries created by git clone
    // should be regular directories, not symlinks pointing outside tempDir.
    for (const dirName of selected) {
      const srcDir = join(tempDir, dirName)
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(srcDir)
      } catch {
        throw new Error(`Extension "${dirName}" not found in temporary directory`)
      }
      if (st.isSymbolicLink()) {
        throw new Error(`Extension "${dirName}" is a symlink — rejected for security`)
      }
      if (!st.isDirectory()) {
        throw new Error(`Extension "${dirName}" not found in temporary directory`)
      }
    }

    const extensionsDir = join(this.settingsDir, 'extensions')
    mkdirSync(extensionsDir, { recursive: true })

    for (const dirName of selected) {
      const srcDir = join(tempDir, dirName)
      const destDir = join(extensionsDir, dirName)
      // Remove old version first to prevent residual files from previous installs
      rmSync(destDir, { recursive: true, force: true })
      cpSync(srcDir, destDir, { recursive: true })
    }

    // Cleanup temp dir
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch (e) {
      log.warn(`[extension-service] failed to cleanup temp dir ${tempDir}: ${toErrorMessage(e)}`)
    }
  }

  /**
   * Cancel installation: clean up temp directory without installing.
   */
  async cancelInstall(tempDir: string): Promise<void> {
    const resolvedTemp = resolve(tempDir)
    const allowedTmpPrefix = resolve(this.settingsDir, 'tmp')
    if (!isStrictlyUnder(allowedTmpPrefix, resolvedTemp)) {
      throw new Error(`Invalid temp directory: ${tempDir}`)
    }

    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch (e) {
      log.warn(`[extension-service] failed to cleanup temp dir on cancel ${tempDir}: ${toErrorMessage(e)}`)
    }
  }

  // ── 内部方法 ──────────────────────────────────────────────────

  /** 读取 settings.json 的 packages[] 和 disabled-packages.json（经 IExtensionSettings port）。 */
  private readSettingsState(): { packages: string[]; disabled: string[] } {
    return {
      packages: this.extSettings.getPackages(),
      disabled: this.extSettings.getDisabled(),
    }
  }

  /** npm install + 错误分类 + isValidPiExtension 验证 + 失败回滚。
   * installExtension 和 upgradeExtension 共用此流程，避免逻辑漂移。 */
  private async installAndValidate(pkgName: string, npmDir: string, contextLabel = 'install'): Promise<void> {
    const nodeModulesDir = join(npmDir, 'node_modules')
    try {
      await this.installer.installNpm(pkgName, nodeModulesDir, { timeout: NPM_INSTALL_TIMEOUT })
    } catch (e) {
      const msg = toErrorMessage(e)
      const errCode = (e as { code?: string }).code
      const code = errCode === 'extract' || errCode === 'integrity'
        ? 'network' as const
        : errCode ?? this.classifyNpmError(msg)
      throw new ExtensionInstallError(
        code,
        `npm install failed: ${msg}`,
        code === 'not_found' ? 'Check the package name, scope, and registry URL.' : undefined,
      )
    }
    const pkgInstallDir = join(nodeModulesDir, pkgName)
    if (!existsSync(pkgInstallDir) || !this.resolver.isValidPiExtension(pkgInstallDir)) {
      try {
        await this.installer.uninstallNpm(pkgName, nodeModulesDir)
      } catch (e) {
        log.warn(`[extension-service] rollback uninstall failed for ${pkgName}: ${toErrorMessage(e)}`)
      }
      throw new ExtensionInstallError(
        'not_extension',
        `"${pkgName}" is not a valid pi extension${contextLabel === 'upgrade' ? ' after upgrade' : ''}.`,
        'Check that the package has pi manifest fields (keywords: ["pi-package"], peerDependencies with pi-coding-agent, or a "pi" field in package.json).',
      )
    }
  }

  /** 从 node_modules/<name>/package.json 读取实际安装版本。
   * getLatestVersion 返回的是 registry dist-tags.latest，与实际安装版本可能因 TOCTOU 不一致。 */
  private readInstalledVersion(pkgName: string, npmDir: string): string {
    try {
      const pkgPath = join(npmDir, 'node_modules', pkgName, 'package.json')
      if (!existsSync(pkgPath)) return ''
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
      return pkg.version ?? ''
    } catch {
      return ''
    }
  }

  /** Classify npm error message into error code */
  private classifyNpmError(msg: string): 'not_found' | 'network' {
    if (/404|E404/i.test(msg)) {
      return 'not_found'
    }
    return 'network'
  }

  /**
   * Recursively discover pi extensions in a directory.
   * - If the directory itself is a valid pi extension, return it as single candidate.
   * - Otherwise, scan subdirectories (skip . and node_modules).
   * - maxDepth limits recursion to prevent runaway scans.
   */
  private discoverExtensions(dir: string, maxDepth = 5 /* eslint-disable-line no-magic-numbers */, depth = 0): ExtensionInfo[] {
    const candidates: ExtensionInfo[] = []

    if (depth > maxDepth) {
      log.warn(`[extension-service] discoverExtensions: max depth ${maxDepth} exceeded at ${dir}, stopping`)
      return candidates
    }

    // Check if dir itself is a valid pi extension
    if (this.resolver.isValidPiExtension(dir)) {
      const info = this.readPackageJson(dir)
      // name is intentionally raw (not normalized) — see readPackageJson doc
      candidates.push({
        name: info.name,
        dirName: basename(dir),
        version: info.version,
        description: info.description,
        path: dir,
        enabled: true,
        source: 'user-installed',
      })
      return candidates
    }

    // Scan subdirectories
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry === '.' || entry === 'node_modules' || entry === '..') continue
        const entryPath = join(dir, entry)
        try {
          const st = lstatSync(entryPath)
          if (!st.isDirectory() || st.isSymbolicLink()) continue
        } catch {
          continue
        }

        // Check if this subdir is a valid pi extension
        if (this.resolver.isValidPiExtension(entryPath)) {
          const info = this.readPackageJson(entryPath)
          candidates.push({
            name: info.name,
            dirName: entry,
            version: info.version,
            description: info.description,
            path: entryPath,
            enabled: true,
            source: 'user-installed',
          })
        } else {
          // Recurse into subdirectory for nested collections
          candidates.push(...this.discoverExtensions(entryPath, maxDepth, depth + 1))
        }
      }
    } catch (e) {
      log.warn(`[extension-service] failed to scan directory ${dir}: ${toErrorMessage(e)}`)
    }

    return candidates
  }

  /**
   * Read package.json from a directory and return name/version/description.
   *
   * NOTE: `name` is intentionally the raw package.json `name` field, NOT
   * normalized via `this.resolver.normalizeExtName()`. Reasons:
   * 1. `ExtensionInfo.name` stores raw names throughout the codebase
   *    (scanNpmExtensions, scanSettingsExtensions, scanDirectory all keep raw).
   * 2. `finishInstall` uses `name` as a directory path for file operations —
   *    normalizing would break tempDir → extensions/ copy.
   * 3. Dedup normalization is handled by ExtensionResolver's internal Maps,
   *    not by individual scan methods or ExtensionInfo fields.
   */
  private readPackageJson(dir: string): { name: string; version: string; description: string } {
    const pkgJsonPath = join(dir, 'package.json')
    try {
      const raw = readFileSync(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(raw) as { name?: string; version?: string; description?: string }
      return {
        name: pkg.name ?? basename(dir),
        version: pkg.version ?? '',
        description: pkg.description ?? '',
      }
    } catch {
      return {
        name: basename(dir),
        version: '',
        description: '',
      }
    }
  }
}

/** npm 包名合法性校验（npm naming spec）。
 * scoped：@scope/name；unscoped：name。只允许小写字母、数字、-_.~ */
function isValidNpmPackageName(name: string): boolean {
  return /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)
}
