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
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, lstatSync, cpSync, rmSync, mkdtempSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { ExtensionInfo } from '@xyz-agent/shared'
import { ExtensionResolver } from './extension-resolver.js'
import { getPiAgentDir } from './pi-config-bridge.js'

const log = {
  info: (...args: unknown[]) => console.log('[extension-service]', ...args),
  warn: (...args: unknown[]) => console.warn('[extension-service]', ...args),
  error: (...args: unknown[]) => console.error('[extension-service]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  debug: (..._args: unknown[]) => { /* no-op in production */ },
}

const NPM_PREFIX_LENGTH = 4 // "npm:" 前缀长度
const INDENT_SPACES = 2
const NPM_INSTALL_TIMEOUT = 60_000
const NPM_UNINSTALL_TIMEOUT = 30_000
const GIT_CLONE_TIMEOUT = 120_000
const DISCOVERY_TEMP_PREFIX = 'ext-scan-'
// eslint-disable-next-line no-magic-numbers
const ORPHAN_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

/** 获取 xyz-agent 的 agent 配置目录 */
function getSettingsDir(): string {
  return getPiAgentDir()
}

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
  /** Agent 配置目录（默认 ~/.xyz-agent/pi/agent） */
  settingsDir?: string
  /** 项目根目录（用于 resolver npm 扫描） */
  projectRoot?: string
  /** 是否打包模式 */
  packaged?: boolean
}

export class ExtensionService {
  private readonly settingsDir: string
  private readonly resolver: ExtensionResolver
  private readonly projectRoot: string
  private readonly packaged: boolean

  /** 文件型 extension 路径（如 xyz-agent-extension.js），打包/开发模式不同 */
  private extensionFilePath: string

  constructor(options?: ExtensionServiceOptions) {
    this.settingsDir = options?.settingsDir ?? getSettingsDir()
    this.resolver = new ExtensionResolver({ settingsDir: this.settingsDir })
    this.projectRoot = options?.projectRoot ?? process.cwd()
    this.packaged = options?.packaged ?? (process.env.XYZ_AGENT_PACKAGED === '1')

    // 文件型 extension 路径
    if (this.packaged) {
      this.extensionFilePath = resolve(process.cwd(), 'xyz-agent-extension.js')
    } else {
      this.extensionFilePath = resolve(this.projectRoot, '..', 'xyz-agent-extension.js')
    }

    // Cleanup orphaned temp directories from previous crashes (>24h old)
    this.cleanupOrphanedTempDirs()
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
        } catch (e) { log.debug(`failed to check temp dir ${fullPath}: ${e instanceof Error ? e.message : String(e)}`) }
      }
    } catch (e) { log.debug(`failed to cleanup orphaned temp dirs: ${e instanceof Error ? e.message : String(e)}`) }
  }

  /**
   * 扫描所有 extension，返回 ExtensionInfo[]。
   * 用 ExtensionResolver 扫描所有源，对 settings 源的扩展读 packages[] 判断启用状态。
   */
  async scanExtensions(): Promise<ExtensionInfo[]> {
    const result = this.resolver.resolve(this.projectRoot, this.packaged, [])
    // 读取 settings.json packages[] 用于判断 source 和 enabled
    const { packages, disabled } = this.readSettingsState()
    const disabledSet = new Set(disabled)

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
        log.debug(`[extension-service] failed to read package.json at ${pkgJsonPath}: ${e instanceof Error ? e.message : String(e)}`)
      }

      // 判断 source：路径在 settings packages[] 中则为 user-installed
      const sourceKey = `npm:${name}`
      const isUserInstalled = packages.some(p => p === `npm:${name}` || p === sourceKey)
      const isDisabled = disabledSet.has(sourceKey)

      extensions.push({
        name,
        dirName: basename(dir),
        version,
        description,
        path: dir,
        enabled: !isDisabled,
        source: isUserInstalled ? 'user-installed' : 'built-in',
      })
    }

    return extensions
  }

  /**
   * 返回启用的 extension 路径列表（供 pi --extension 参数使用）。
   * 封装 ExtensionResolver.resolve() + 过滤禁用项 + 追加文件型 extension。
   */
  async getExtensionPaths(): Promise<string[]> {
    const result = this.resolver.resolve(this.projectRoot, this.packaged, [])
    const { disabled } = this.readSettingsState()
    const disabledSet = new Set(disabled)

    // 过滤禁用项
    const filtered = result.extensionDirs.filter(dir => {
      const dirName = basename(dir)
      return !disabledSet.has(`npm:${dirName}`)
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
   */
  async installExtension(source: string): Promise<void> {
    if (!source.startsWith('npm:')) {
      throw new Error(`Unsupported source: ${source}. Only npm:xxx format is supported.`)
    }

    const pkgName = source.slice(NPM_PREFIX_LENGTH)
    const npmDir = join(this.settingsDir, 'npm')

    // 确保 npm 目录有 package.json
    if (!existsSync(npmDir)) {
      mkdirSync(npmDir, { recursive: true })
    }
    const pkgJsonPath = join(npmDir, 'package.json')
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(pkgJsonPath, JSON.stringify({ private: true }), 'utf-8')
    }

    // 执行 npm install
    try {
      execFileSync('npm', ['install', pkgName, '--prefix', npmDir, '--omit=peer'], {
        stdio: 'pipe',
        timeout: NPM_INSTALL_TIMEOUT,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = this.classifyNpmError(msg)
      throw new ExtensionInstallError(
        code,
        `npm install failed: ${msg}`,
        code === 'not_found' ? 'Check the package name, scope, and registry URL.' : undefined,
      )
    }

    // 验证是否为有效的 pi extension
    const pkgInstallDir = join(npmDir, 'node_modules', pkgName)
    if (!existsSync(pkgInstallDir) || !this.resolver.isValidPiExtension(pkgInstallDir)) {
      // 回滚
      try {
        execFileSync('npm', ['uninstall', pkgName, '--prefix', npmDir], { stdio: 'pipe', timeout: NPM_UNINSTALL_TIMEOUT })
      } catch (e) {
        log.warn(`[extension-service] rollback npm uninstall failed for ${pkgName}: ${e instanceof Error ? e.message : String(e)}`)
      }
      throw new ExtensionInstallError(
        'not_extension',
        `"${pkgName}" is not a valid pi extension.`,
        'Check that the package has pi manifest fields (keywords: ["pi-package"], peerDependencies with pi-coding-agent, or a "pi" field in package.json).',
      )
    }

    // 写入 settings.json
    const settingsPath = join(this.settingsDir, 'settings.json')
    let settings: { packages?: string[] } = {}
    try {
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      }
    } catch (e) {
      log.debug(`[extension-service] failed to read settings.json for install: ${e instanceof Error ? e.message : String(e)}`)
    }

    const packages = settings.packages ?? []
    if (!packages.includes(source)) {
      packages.push(source)
    }
    settings.packages = packages

    // 原子写入
    const tmpPath = settingsPath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(settings, null, INDENT_SPACES), 'utf-8')
    renameSync(tmpPath, settingsPath)
  }

  /**
   * 从 settings.json packages[] 移除 → 清理 disabled-packages.json → npm uninstall。
   */
  async uninstallExtension(name: string): Promise<void> {
    const source = `npm:${name}`
    const settingsPath = join(this.settingsDir, 'settings.json')

    // 从 settings packages[] 移除
    if (existsSync(settingsPath)) {
      try {
        const raw = readFileSync(settingsPath, 'utf-8')
        const settings = JSON.parse(raw) as { packages?: string[] }
        const packages = (settings.packages ?? []).filter(p => p !== source)
        settings.packages = packages
        const tmpPath = settingsPath + '.tmp'
        writeFileSync(tmpPath, JSON.stringify(settings, null, INDENT_SPACES), 'utf-8')
        renameSync(tmpPath, settingsPath)
      } catch (e) {
        log.warn(`[extension-service] failed to update settings.json for uninstall: ${e}`)
      }
    }

    // 从 disabled-packages.json 清理
    const disabledPath = join(this.settingsDir, 'disabled-packages.json')
    if (existsSync(disabledPath)) {
      try {
        const raw = readFileSync(disabledPath, 'utf-8')
        const data = JSON.parse(raw) as { disabled?: string[] }
        const disabled = (data.disabled ?? []).filter(d => d !== source)
        if (disabled.length > 0) {
          writeFileSync(disabledPath, JSON.stringify({ disabled }, null, INDENT_SPACES), 'utf-8')
        } else {
          try {
            renameSync(disabledPath, disabledPath + '.bak')
          } catch (e) {
            log.debug(`[extension-service] failed to backup disabled-packages.json: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } catch (e) {
        log.debug(`[extension-service] failed to update disabled-packages.json for uninstall: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // npm uninstall
    const npmDir = join(this.settingsDir, 'npm')
    if (existsSync(npmDir)) {
      try {
        execFileSync('npm', ['uninstall', name, '--prefix', npmDir], { stdio: 'pipe', timeout: NPM_UNINSTALL_TIMEOUT })
      } catch (e) {
        log.warn(`[extension-service] npm uninstall warning for ${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /**
   * 切换某个包的启用/禁用。
   * 通过 disabled-packages.json 实现。
   */
  async toggleExtension(name: string, enabled: boolean): Promise<void> {
    const source = `npm:${name}`
    const disabledPath = join(this.settingsDir, 'disabled-packages.json')

    let disabled: string[] = []
    if (existsSync(disabledPath)) {
      try {
        const raw = readFileSync(disabledPath, 'utf-8')
        disabled = (JSON.parse(raw) as { disabled?: string[] }).disabled ?? []
      } catch (e) {
        log.debug(`[extension-service] failed to read disabled-packages.json for toggle: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (enabled) {
      disabled = disabled.filter(d => d !== source)
    } else {
      if (!disabled.includes(source)) {
        disabled.push(source)
      }
    }

    if (disabled.length > 0) {
      writeFileSync(disabledPath, JSON.stringify({ disabled }, null, INDENT_SPACES), 'utf-8')
    } else if (existsSync(disabledPath)) {
      try {
        renameSync(disabledPath, disabledPath + '.bak')
      } catch (e) {
        log.debug(`[extension-service] failed to backup disabled-packages.json: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
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

    if (!statSync(absPath).isDirectory()) {
      throw new Error(`Source path is not a directory: ${absPath}`)
    }

    // Restrict source path to safe directories (home or os.tmpdir())
    const homeDir = homedir()
    const isUnderHome = absPath.startsWith(homeDir + '/') || absPath === homeDir
    const sysTmpDir = tmpdir()
    const isUnderTmp = absPath.startsWith(sysTmpDir + '/') || absPath === sysTmpDir
    if (!isUnderHome && !isUnderTmp) {
      throw new Error(`Source path must be under home directory or /tmp`)
    }

    // Ensure tmp parent directory exists
    const tmpParent = join(this.settingsDir, 'tmp')
    mkdirSync(tmpParent, { recursive: true })

    // Create temp directory
    const tempDir = mkdtempSync(join(tmpParent, DISCOVERY_TEMP_PREFIX))

    // Copy source to temp, clean up on failure
    try {
      cpSync(absPath, tempDir, { recursive: true })
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
    const ALLOWED_GIT_PREFIXES = ['https://', 'http://', 'git://', 'ssh://', 'git@']
    if (!ALLOWED_GIT_PREFIXES.some(p => url.startsWith(p))) {
      throw new Error(`Invalid Git URL: ${url}. Must start with one of: ${ALLOWED_GIT_PREFIXES.join(', ')}`)
    }

    // Git clone — use execFileSync to prevent command injection
    try {
      execFileSync('git', ['clone', '--depth', '1', url, tempDir], {
        stdio: 'pipe',
        timeout: GIT_CLONE_TIMEOUT,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Cleanup temp dir on failure
      try { rmSync(tempDir, { recursive: true, force: true }) } catch (cleanupErr) {
        log.warn('[extension-service] failed to cleanup temp dir:', cleanupErr)
      }
      throw new Error(`git clone failed: ${msg}`)
    }

    // If package.json exists, run npm install
    if (existsSync(join(tempDir, 'package.json'))) {
      try {
        execFileSync('npm', ['install', '--omit=peer'], {
          cwd: tempDir,
          stdio: 'pipe',
          timeout: NPM_INSTALL_TIMEOUT,
        })
      } catch (e) {
        log.warn(`[extension-service] npm install in git repo failed: ${e instanceof Error ? e.message : String(e)}`)
        // Non-fatal — some repos don't need deps to discover extensions
      }
    }

    // Discover extensions
    const candidates = this.discoverExtensions(tempDir)

    return { tempDir, candidates }
  }

  /**
   * Finish installation: copy selected extensions from temp dir to extensions/ directory.
   * Cleans up temp dir after copying.
   * @param selected - Array of dirName values (filesystem basenames) from discovered candidates.
   *   NOT npm package names — scoped packages have dirName = basename(dir).
   */
  async finishInstall(tempDir: string, selected: string[]): Promise<void> {
    // Validate tempDir is within settingsDir/tmp
    const resolvedTemp = resolve(tempDir)
    const allowedTmpPrefix = resolve(this.settingsDir, 'tmp')
    if (!resolvedTemp.startsWith(allowedTmpPrefix + '/')) {
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
    for (const dirName of selected) {
      const srcDir = join(tempDir, dirName)
      if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
        throw new Error(`Extension "${dirName}" not found in temporary directory`)
      }
    }

    const extensionsDir = join(this.settingsDir, 'extensions')
    mkdirSync(extensionsDir, { recursive: true })

    for (const dirName of selected) {
      const srcDir = join(tempDir, dirName)
      const destDir = join(extensionsDir, dirName)
      cpSync(srcDir, destDir, { recursive: true })
    }

    // Cleanup temp dir
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch (e) {
      log.warn(`[extension-service] failed to cleanup temp dir ${tempDir}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Cancel installation: clean up temp directory without installing.
   */
  async cancelInstall(tempDir: string): Promise<void> {
    const resolvedTemp = resolve(tempDir)
    const allowedTmpPrefix = resolve(this.settingsDir, 'tmp')
    if (!resolvedTemp.startsWith(allowedTmpPrefix + '/')) {
      throw new Error(`Invalid temp directory: ${tempDir}`)
    }

    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch (e) {
      log.warn(`[extension-service] failed to cleanup temp dir on cancel ${tempDir}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── 内部方法 ──────────────────────────────────────────────────

  /** 读取 settings.json 的 packages[] 和 disabled-packages.json */
  private readSettingsState(): { packages: string[]; disabled: string[] } {
    const settingsPath = join(this.settingsDir, 'settings.json')
    let packages: string[] = []
    try {
      if (existsSync(settingsPath)) {
        packages = (JSON.parse(readFileSync(settingsPath, 'utf-8')) as { packages?: string[] }).packages ?? []
      }
    } catch (e) {
      log.debug(`[extension-service] failed to read settings.json packages: ${e instanceof Error ? e.message : String(e)}`)
    }

    const disabledPath = join(this.settingsDir, 'disabled-packages.json')
    let disabled: string[] = []
    try {
      if (existsSync(disabledPath)) {
        disabled = (JSON.parse(readFileSync(disabledPath, 'utf-8')) as { disabled?: string[] }).disabled ?? []
      }
    } catch (e) {
      log.debug(`[extension-service] failed to read disabled-packages.json: ${e instanceof Error ? e.message : String(e)}`)
    }

    return { packages, disabled }
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
      log.warn(`[extension-service] failed to scan directory ${dir}: ${e instanceof Error ? e.message : String(e)}`)
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
