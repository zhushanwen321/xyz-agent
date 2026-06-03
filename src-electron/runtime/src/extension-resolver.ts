/**
 * ExtensionResolver — 五源扫描与去重
 *
 * 扫描五个来源的 extension，按优先级去重后返回目录路径列表：
 *   npm > user > settings > third-party > bundled
 *
 * npm 扫描：读取 package.json 的 dependencies，对每个包用 require.resolve 定位目录，
 * 再用 isValidPiExtension() 验证是否为有效 pi extension。
 * 不硬编码 scope 或前缀 —— dependencies 本身就是白名单。
 *
 * settings 扫描：读取 ~/.xyz-agent/pi/agent/settings.json 的 packages[]，
 * 定位 ~/.xyz-agent/pi/agent/npm/node_modules/ 下的扩展目录。
 * disabled-packages.json 控制启用/禁用状态。
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const log = {
  info: (...args: unknown[]) => console.log('[extension-resolver]', ...args),
  warn: (...args: unknown[]) => console.warn('[extension-resolver]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  debug: (..._args: unknown[]) => {},
}

/** 优先级：数值越小优先级越高（npm 最高） */
const PRIORITY_ORDER = ['npm', 'user', 'settings', 'third-party', 'bundled'] as const
type SourceName = (typeof PRIORITY_ORDER)[number]

/** 扫描结果：extension name → 目录绝对路径 */
type ExtensionMap = Map<string, string>

export interface ExtensionPaths {
  extensionDirs: string[]
}

export interface SourceMap {
  source: SourceName
  extensions: ExtensionMap
}

export interface ResolverOptions {
  /** 打包模式下的 npm 扫描搜索路径（默认用 process.cwd()） */
  npmResolvePaths?: string[]
  /** 用户 settings 目录，默认 ~/.xyz-agent/pi/agent */
  settingsDir?: string
}

export class ExtensionResolver {
  constructor(private readonly options: ResolverOptions = {}) {}

  /**
   * 解析所有 extension 路径，按优先级去重。
   * deduplicate() 按 PRIORITY_ORDER 升序遍历（高优先级先写入），first-write-wins。
   */
  resolve(projectRoot: string, packaged: boolean, userExtPaths: string[]): ExtensionPaths {
    const sources: SourceMap[] = []

    sources.push({ source: 'bundled', extensions: this.scanBundledExtensions(projectRoot, packaged) })
    sources.push({ source: 'third-party', extensions: this.scanThirdPartyExtensions() })
    sources.push({ source: 'settings', extensions: this.scanSettingsExtensions() })
    if (userExtPaths.length > 0) {
      sources.push({ source: 'user', extensions: this.scanUserExtensions(userExtPaths) })
    }
    sources.push({ source: 'npm', extensions: this.scanNpmExtensions(projectRoot) })

    const deduped = this.deduplicate(sources)
    log.info(`[extension-resolver] resolved ${deduped.size} extensions from ${sources.length} sources`)
    return { extensionDirs: [...deduped.values()] }
  }

  /**
   * 扫描 npm extension：从 package.json dependencies 提取白名单
   */
  scanNpmExtensions(projectRoot: string): ExtensionMap {
    const result: ExtensionMap = new Map()
    const pkgJsonPath = join(projectRoot, 'package.json')

    if (!existsSync(pkgJsonPath)) return result

    let dependencies: Record<string, string>
    try {
      const raw = readFileSync(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
      dependencies = pkg.dependencies ?? {}
    } catch {
      log.warn(`[extension-resolver] failed to read ${pkgJsonPath}`)
      return result
    }

    const resolvePaths = this.options.npmResolvePaths ?? [projectRoot]

    for (const pkgName of Object.keys(dependencies)) {
      let pkgDir: string
      try {
        const resolved = require.resolve(`${pkgName}/package.json`, { paths: resolvePaths })
        pkgDir = dirname(resolved)
      } catch {
        continue
      }

      if (!this.isValidPiExtension(pkgDir)) continue

      const extName = this.normalizeExtName(pkgName)
      result.set(extName, pkgDir)
    }

    return result
  }

  /**
   * 扫描 user-installed extensions。
   * 读取 ~/.xyz-agent/pi/agent/settings.json 的 packages[]，
   * 过滤 disabled-packages.json 中的禁用项，
   * 定位 npm/ 目录下的扩展。
   */
  scanSettingsExtensions(): ExtensionMap {
    const result: ExtensionMap = new Map()
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const settingsDir = this.options.settingsDir ?? (homeDir ? join(homeDir, '.xyz-agent', 'pi', 'agent') : '')
    const settingsPath = join(settingsDir, 'settings.json')
    if (!existsSync(settingsPath)) return result

    // 读取 disabled-packages.json
    const disabled = this.readDisabledPackages(settingsDir)

    // 读取 packages[]
    let packages: string[]
    try {
      const raw = readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw) as { packages?: string[] }
      packages = settings.packages ?? []
    } catch {
      log.warn(`[extension-resolver] failed to parse ${settingsPath}`)
      return result
    }

    for (const source of packages) {
      if (!source.startsWith('npm:')) continue
      if (disabled.has(source)) continue

      const pkgName = source.slice(4) // 去掉 "npm:"
      const pkgDir = join(settingsDir, 'npm', 'node_modules', pkgName)

      if (!existsSync(pkgDir)) {
        log.debug(`[extension-resolver] settings package not installed: ${pkgName}`)
        continue
      }

      if (!this.isValidPiExtension(pkgDir)) continue

      const extName = this.normalizeExtName(pkgName)
      result.set(extName, pkgDir)
    }

    return result
  }

  /**
   * 读取 disabled-packages.json，返回禁用的 source 集合。
   * 文件不存在时返回空集合。
   */
  private readDisabledPackages(settingsDir: string): Set<string> {
    const disabledPath = join(settingsDir, 'disabled-packages.json')
    if (!existsSync(disabledPath)) return new Set()

    try {
      const raw = readFileSync(disabledPath, 'utf-8')
      const data = JSON.parse(raw) as { disabled?: string[] }
      return new Set(data.disabled ?? [])
    } catch {
      log.warn(`[extension-resolver] failed to parse ${disabledPath}`)
      return new Set()
    }
  }

  /**
   * 扫描 bundled extensions
   */
  scanBundledExtensions(projectRoot: string, packaged: boolean): ExtensionMap {
    if (packaged) return new Map()

    const result: ExtensionMap = new Map()
    const bundledDir = join(projectRoot, 'resources', 'pi', 'agent', 'extensions')

    if (!existsSync(bundledDir)) return result

    this.scanDirectory(bundledDir, result, 'bundled')
    return result
  }

  /**
   * 扫描第三方 extensions：~/.xyz-agent/pi/agent/extensions/
   */
  scanThirdPartyExtensions(): ExtensionMap {
    const result: ExtensionMap = new Map()
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    if (!homeDir) return result

    const thirdPartyDir = join(homeDir, '.xyz-agent', 'pi', 'agent', 'extensions')
    if (!existsSync(thirdPartyDir)) return result

    this.scanDirectory(thirdPartyDir, result, 'third-party')
    return result
  }

  /**
   * 扫描用户指定的 extension 路径列表
   */
  scanUserExtensions(userExtPaths: string[]): ExtensionMap {
    const result: ExtensionMap = new Map()

    for (const extPath of userExtPaths) {
      if (!existsSync(extPath)) continue
      try {
        if (!statSync(extPath).isDirectory()) continue
      } catch {
        continue
      }
      const extName = this.normalizeExtName(extPath.split('/').pop() ?? extPath)
      result.set(extName, extPath)
    }

    return result
  }

  /**
   * 去重：按 PRIORITY_ORDER 升序遍历（高优先级在前），first-write-wins。
   */
  deduplicate(sources: SourceMap[]): ExtensionMap {
    const merged: ExtensionMap = new Map()

    const sorted = [...sources].sort((a, b) => {
      return PRIORITY_ORDER.indexOf(a.source) - PRIORITY_ORDER.indexOf(b.source)
    })

    for (const { extensions } of sorted) {
      for (const [name, path] of extensions) {
        if (!merged.has(name)) {
          merged.set(name, path)
        }
      }
    }

    return merged
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * 验证包是否为有效的 pi extension。
   * 有效条件（满足任一）：
   * - keywords 包含 'pi-package'
   * - peerDependencies 包含含 'pi-coding-agent' 或 'pi-agent-core' 的包
   * - package.json 中有 'pi' manifest 字段
   */
  private isValidPiExtension(pkgDir: string): boolean {
    const pkgJsonPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) return false

    try {
      const raw = readFileSync(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(raw) as {
        pi?: unknown
        keywords?: string[]
        peerDependencies?: Record<string, string>
      }

      if (pkg.pi) return true
      if (pkg.keywords?.includes('pi-package')) return true

      const peerDeps = Object.keys(pkg.peerDependencies ?? {})
      if (peerDeps.some(d => /pi-coding-agent|pi-agent-core/.test(d))) return true

      return false
    } catch {
      return false
    }
  }

  /**
   * 规范化 extension name 用于去重。
   * - 去掉 npm scope: @zhushanwen/pi-goal → pi-goal
   * - 去掉 pi- 前缀: pi-goal → goal, pi-subagents → subagents
   */
  private normalizeExtName(name: string): string {
    const unscoped = name.replace(/^@[^/]+\//, '')
    return unscoped.replace(/^pi-/, '')
  }

  /** 扫描目录下的子目录，跳过 shared/ */
  private scanDirectory(dir: string, result: ExtensionMap, label: string): void {
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry === 'shared') continue
        const entryPath = join(dir, entry)
        try {
          if (!statSync(entryPath).isDirectory()) continue
        } catch {
          continue
        }
        result.set(this.normalizeExtName(entry), entryPath)
      }
      log.debug(`[extension-resolver] ${label}: found ${result.size} extensions in ${dir}`)
    } catch (e) {
      log.warn(`[extension-resolver] failed to scan ${label} dir ${dir}: ${e}`)
    }
  }
}
