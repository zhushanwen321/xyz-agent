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
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ExtensionInfo } from '@xyz-agent/shared'
import { ExtensionResolver } from './extension-resolver.js'

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

/** 获取 xyz-agent 的 agent 配置目录 */
function getSettingsDir(): string {
  return join(homedir(), '.xyz-agent', 'pi', 'agent')
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
      let name = dir.split('/').pop() ?? ''
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
      const dirName = dir.split('/').pop() ?? ''
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
      execSync(`npm install ${pkgName} --prefix ${npmDir} --omit=peer`, {
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
        execSync(`npm uninstall ${pkgName} --prefix ${npmDir}`, { stdio: 'pipe', timeout: NPM_UNINSTALL_TIMEOUT })
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
        execSync(`npm uninstall ${name} --prefix ${npmDir}`, { stdio: 'pipe', timeout: NPM_UNINSTALL_TIMEOUT })
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

    // Create temp directory
    const tempDir = join(this.settingsDir, 'tmp', `${DISCOVERY_TEMP_PREFIX}${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })

    // Copy source to temp
    cpSync(absPath, tempDir, { recursive: true })

    // Discover extensions
    const candidates = this.discoverExtensions(tempDir)

    return { tempDir, candidates }
  }

  /**
   * Install from a Git repository URL.
   * Clones to temp dir, optionally runs npm install, discovers extensions.
   */
  async installGitRepository(url: string): Promise<{ tempDir: string; candidates: ExtensionInfo[] }> {
    // Create temp directory
    const tempDir = join(this.settingsDir, 'tmp', `${DISCOVERY_TEMP_PREFIX}${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })

    // Git clone
    try {
      execSync(`git clone --depth 1 "${url}" "${tempDir}"`, {
        stdio: 'pipe',
        timeout: GIT_CLONE_TIMEOUT,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Cleanup temp dir on failure
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new Error(`git clone failed: ${msg}`)
    }

    // If package.json exists, run npm install
    if (existsSync(join(tempDir, 'package.json'))) {
      try {
        execSync('npm install --omit=peer', {
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
   */
  async finishInstall(tempDir: string, selected: string[]): Promise<void> {
    const extensionsDir = join(this.settingsDir, 'extensions')
    mkdirSync(extensionsDir, { recursive: true })

    for (const name of selected) {
      const srcDir = join(tempDir, name)
      if (!existsSync(srcDir)) {
        throw new Error(`Selected extension "${name}" not found in temp directory`)
      }
      const destDir = join(extensionsDir, name)
      cpSync(srcDir, destDir, { recursive: true })
    }

    // Cleanup temp dir
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch (e) {
      log.warn(`[extension-service] failed to cleanup temp dir ${tempDir}: ${e instanceof Error ? e.message : String(e)}`)
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
   */
  private discoverExtensions(dir: string): ExtensionInfo[] {
    const candidates: ExtensionInfo[] = []

    // Check if dir itself is a valid pi extension
    if (this.resolver.isValidPiExtension(dir)) {
      const info = this.readPackageJson(dir)
      // name is intentionally raw (not normalized) — see readPackageJson doc
      candidates.push({
        name: info.name,
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
        if (entry === '.' || entry === 'node_modules') continue
        const entryPath = join(dir, entry)
        try {
          if (!statSync(entryPath).isDirectory()) continue
        } catch {
          continue
        }

        // Check if this subdir is a valid pi extension
        if (this.resolver.isValidPiExtension(entryPath)) {
          const info = this.readPackageJson(entryPath)
          candidates.push({
            name: info.name,
            version: info.version,
            description: info.description,
            path: entryPath,
            enabled: true,
            source: 'user-installed',
          })
        } else {
          // Recurse into subdirectory for nested collections
          candidates.push(...this.discoverExtensions(entryPath))
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
        name: pkg.name ?? dir.split('/').pop() ?? '',
        version: pkg.version ?? '',
        description: pkg.description ?? '',
      }
    } catch {
      return {
        name: dir.split('/').pop() ?? '',
        version: '',
        description: '',
      }
    }
  }
}
