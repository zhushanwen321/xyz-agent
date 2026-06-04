/**
 * ExtensionService — 管理 pi extension 生命周期。
 *
 * 使用 ExtensionResolver 做发现，settings.json 管理 packages[]，
 * disabled-packages.json 管理启用/禁用状态。
 *
 * 旧版（扫描 ~/.xyz-agent/extensions/ + extension-state.json）已废弃。
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
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

/** 获取 xyz-agent 的 agent 配置目录 */
function getSettingsDir(): string {
  return join(homedir(), '.xyz-agent', 'pi', 'agent')
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
      throw new Error(`npm install failed: ${msg}`)
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
      throw new Error(`"${pkgName}" is not a valid pi extension.`)
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
          // 空的 disabled 列表 → 备份后不再使用
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
      // 启用：从 disabled 列表移除
      disabled = disabled.filter(d => d !== source)
    } else {
      // 禁用：追加
      if (!disabled.includes(source)) {
        disabled.push(source)
      }
    }

    if (disabled.length > 0) {
      writeFileSync(disabledPath, JSON.stringify({ disabled }, null, INDENT_SPACES), 'utf-8')
    } else if (existsSync(disabledPath)) {
      // 空列表备份
      try {
        renameSync(disabledPath, disabledPath + '.bak')
      } catch (e) {
        log.debug(`[extension-service] failed to backup disabled-packages.json: ${e instanceof Error ? e.message : String(e)}`)
      }
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
}
