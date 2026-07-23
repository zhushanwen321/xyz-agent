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
 * 定位 ~/.xyz-agent/npm/node_modules/ 下的扩展目录。
 * disabled-packages.json 控制启用/禁用状态。
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { getPiAgentDir, getNpmDir, getExtensionsDir } from '../pi/pi-paths.js'
import { readSettings } from '../pi/pi-settings-store.js'
import { readDisabledPackages as readDisabledPackagesFromStore } from '../pi/pi-extension-settings.js'
import type { IExtensionResolver, ExtensionPaths } from '../../services/ports/installer.js'

// re-export ExtensionPaths 供历史 import 此文件的消费者使用（类型归属 ports）
export type { ExtensionPaths }

const log = {
  info: (...args: unknown[]) => console.log('[extension-resolver]', ...args),
  warn: (...args: unknown[]) => console.warn('[extension-resolver]', ...args),
   
  debug: (..._args: unknown[]) => {},
}

/** 优先级：数值越小优先级越高（npm 最高） */
const PRIORITY_ORDER = ['npm', 'user', 'discovery', 'settings', 'third-party', 'bundled'] as const
type SourceName = (typeof PRIORITY_ORDER)[number]

/** 扫描结果：extension name → 目录绝对路径 */
type ExtensionMap = Map<string, string>

// ExtensionPaths 定义在 services/ports.ts（依赖倒置：infra 实现接口，类型归属 service 契约）。
// 文件顶部已 re-export，此处不再重复。

export interface SourceMap {
  source: SourceName
  extensions: ExtensionMap
}

export interface ResolverOptions {
  /** 打包模式下的 npm 扫描搜索路径（默认用 process.cwd()） */
  npmResolvePaths?: string[]
  /** 用户 settings 目录，默认 ~/.xyz-agent/pi/agent */
  settingsDir?: string
  /** 第三方 extensions 目录，默认 ~/.xyz-agent/extensions */
  thirdPartyDir?: string
  /** npm 安装目录，默认 ~/.xyz-agent/npm（settings 源定位 node_modules 用） */
  npmDir?: string
}

export class ExtensionResolver implements IExtensionResolver {
  constructor(private readonly options: ResolverOptions = {}) {}

  /**
   * 解析所有 extension 路径，按优先级去重。
   * deduplicate() 按 PRIORITY_ORDER 升序遍历（高优先级先写入），first-write-wins。
   *
   * @param discoveryExtDirs 用户在 discovery.json 勾选的额外扫描目录（P1 pi 原生 + P2 xyz-agent），
   *   复刻 pi 的 collectAutoExtensionEntries 三种结构识别（单文件/index.ts/manifest）
   */
  resolve(projectRoot: string, packaged: boolean, userExtPaths: string[], discoveryExtDirs: string[] = []): ExtensionPaths {
    const sources: SourceMap[] = []

    sources.push({ source: 'bundled', extensions: this.scanBundledExtensions(projectRoot, packaged) })
    sources.push({ source: 'third-party', extensions: this.scanThirdPartyExtensions() })
    sources.push({ source: 'settings', extensions: this.scanSettingsExtensions() })
    if (userExtPaths.length > 0) {
      sources.push({ source: 'user', extensions: this.scanUserExtensions(userExtPaths) })
    }
    if (discoveryExtDirs.length > 0) {
      sources.push({ source: 'discovery', extensions: this.scanDiscoveryExtensions(discoveryExtDirs) })
    }
    sources.push({ source: 'npm', extensions: this.scanNpmExtensions(projectRoot, packaged) })

    const deduped = this.deduplicate(sources)
    log.info(`[extension-resolver] resolved ${deduped.size} extensions from ${sources.length} sources`)
    return { extensionDirs: [...deduped.values()] }
  }

  /**
   * 扫描 npm extension：从 package.json dependencies 提取白名单。
   *
   * 注意（2026-07-04 任务一后）：builtin @zhushanwen/pi-* 已改为 Settings 推荐安装，
   * 不再打包进产物（electron-builder.yml 移除了 @zhushanwen extraResources 拷贝）。
   * 打包模式下此方法扫描 Resources/node_modules/@zhushanwen/，目录不存在时
   * existsSync 兜底返回空 Map（用户通过 Settings 安装的扩展走 settings 源，不经过此方法）。
   *
   * 开发模式下 projectRoot = apps/electron（runtime cwd），读 apps/electron/package.json
   * 的 dependencies。@zhushanwen/pi-* 不再是根依赖，此处返回空。
   */
  scanNpmExtensions(projectRoot: string, packaged: boolean): ExtensionMap {
    const result: ExtensionMap = new Map()

    // 打包模式：不用读 package.json，直接从 extraResources 拷贝的 node_modules 扫描
    if (packaged) {
      const bundledNmDir = join(projectRoot, 'node_modules', '@zhushanwen')
      if (!existsSync(bundledNmDir)) return result
      try {
        const entries = readdirSync(bundledNmDir)
        for (const entry of entries) {
          const pkgDir = join(bundledNmDir, entry)
          if (!statSync(pkgDir).isDirectory()) continue
          if (!this.isValidPiExtension(pkgDir)) continue
          result.set(this.normalizeExtName(entry), pkgDir)
        }
      } catch (e) {
        log.warn(`[extension-resolver] failed to scan packaged node_modules: ${e}`)
      }
      return result
    }

    // 开发模式：从 package.json dependencies 白名单 resolve
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
   * 读取 settings.json 的 packages[]（经 pi-settings-store 统一读写层，D17），
   * 过滤 disabled-packages.json 中的禁用项，
   * 定位 npm/目录下的扩展。
   */
  scanSettingsExtensions(): ExtensionMap {
    const result: ExtensionMap = new Map()
    const settingsDir = this.options.settingsDir ?? getPiAgentDir()

    // 读取 disabled-packages.json（xyz-agent 自己的文件，独立读）
    const disabled = this.readDisabledPackages(settingsDir)

    // 读取 packages[]（经 pi-settings-store 单一所有者；测试经 setSettingsPath 对齐 settingsDir）
    const settings = readSettings()
    const packages: string[] = settings.packages ?? []

    for (const source of packages) {
      if (!source.startsWith('npm:')) continue
      if (disabled.has(source)) continue

      const NPM_PREFIX_LEN = 4
      const pkgName = source.slice(NPM_PREFIX_LEN)
      const pkgDir = join(this.options.npmDir ?? getNpmDir(), 'node_modules', pkgName)

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
   * F6: 经 pi-extension-settings 的单一读取入口（与 PiExtensionSettings 同源 JsonStore，
   * 杜绝同进程双读 split-brain）。文件不存在时返回空集合。
   */
  private readDisabledPackages(settingsDir: string): Set<string> {
    return new Set(readDisabledPackagesFromStore(settingsDir))
  }

  /**
   * 扫描 bundled extensions
   *
   * dev 模式：projectRoot = apps/electron（runtime 子进程 cwd），bundled extensions
   * 在 repo root 的 resources/pi/agent/extensions/（与 apps/electron 平级的 resources/ 目录）。
   * repo root 相对 apps/electron 是 ../..
   */
  scanBundledExtensions(projectRoot: string, packaged: boolean): ExtensionMap {
    if (packaged) return new Map()

    const result: ExtensionMap = new Map()
    const bundledDir = join(projectRoot, '..', '..', 'resources', 'pi', 'agent', 'extensions')

    if (!existsSync(bundledDir)) return result

    this.scanDirectory(bundledDir, result, 'bundled')
    return result
  }

  /**
   * 扫描第三方 extensions：~/.xyz-agent/extensions/（local/git 安装目录）
   */
  scanThirdPartyExtensions(): ExtensionMap {
    const result: ExtensionMap = new Map()
    const thirdPartyDir = this.options.thirdPartyDir ?? getExtensionsDir()
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
      if (!this.isValidPiExtension(extPath)) continue
      const extName = this.normalizeExtName(basename(extPath))
      result.set(extName, extPath)
    }

    return result
  }

  /**
   * 扫描用户在 discovery.json 勾选的额外目录（P1 pi 原生 + P2 xyz-agent + 自定义）。
   *
   * 复刻 pi 的 collectAutoExtensionEntries（pi-mono package-manager.ts:575）：
   * 支持三种 extension 结构——单文件 *.ts/*.js、子目录 index.ts/index.js、
   * package.json 的 pi.extensions manifest 字段。只识别路径返回，不加载模块（加载仍由 pi 完成）。
   *
   * 与 scanThirdPartyExtensions 的区别：后者只识别「子目录 + isValidPiExtension」结构，
   * discovery 扫描复刻 pi 原生完整识别（含单文件和 manifest 入口），保证勾选 pi 原生目录
   * （如 ~/.pi/agent/extensions）时行为与 pi 自身扫描一致。
   */
  scanDiscoveryExtensions(dirs: string[]): ExtensionMap {
    const result: ExtensionMap = new Map()
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const entries = this.collectExtensionEntries(dir)
      for (const entryPath of entries) {
        // 用入口路径的父目录名（子目录形式）或文件名（单文件形式）做 dedup key
        const isFile = entryPath.endsWith('.ts') || entryPath.endsWith('.js')
        const name = isFile ? basename(entryPath).replace(/\.(ts|js)$/, '') : basename(dirname(entryPath))
        const extName = this.normalizeExtName(name)
        if (!result.has(extName)) {
          result.set(extName, isFile ? entryPath : dirname(entryPath))
        }
      }
    }
    return result
  }

  /**
   * 复刻 pi 的 collectAutoExtensionEntries：扫描一个目录，识别 extension 入口路径列表。
   *
   * 逻辑（与 pi 一致）：
   * 1. 先检查目录自身是否是 extension（resolveExtensionEntries）
   * 2. 否则遍历子项：单文件 *.ts/*.js 直接收集，子目录递归 resolveExtensionEntries
   * 3. 跳过 .开头 和 node_modules（pi 用 ignore 库做 gitignore 过滤，xyz-agent discovery
   *    目录是用户明确勾选的，不需要 gitignore 过滤）
   */
  private collectExtensionEntries(dir: string): string[] {
    // 先检查目录自身是否有 explicit extension entries
    const rootEntries = this.resolveExtensionEntries(dir)
    if (rootEntries) return rootEntries

    const entries: string[] = []
    try {
      const dirEntries = readdirSync(dir, { withFileTypes: true })
      for (const entry of dirEntries) {
        if (entry.name.startsWith('.')) continue
        if (entry.name === 'node_modules') continue

        const fullPath = join(dir, entry.name)
        let isDir = entry.isDirectory()
        let isFile = entry.isFile()

        // 符号链接解析真实类型（与 pi 一致）
        if (entry.isSymbolicLink()) {
          try {
            const stats = statSync(fullPath)
            isDir = stats.isDirectory()
            isFile = stats.isFile()
          } catch {
            continue
          }
        }

        if (isFile && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          entries.push(fullPath)
        } else if (isDir) {
          const resolved = this.resolveExtensionEntries(fullPath)
          if (resolved) {
            entries.push(...resolved)
          }
        }
      }
    } catch {
      // 目录读取失败，静默跳过（与 pi 一致）
    }
    return entries
  }

  /**
   * 复刻 pi 的 resolveExtensionEntries（package-manager.ts:545）：
   * 解析一个目录的 extension 入口，三种结构按优先级：
   * 1. package.json 的 pi.extensions manifest 字段 → 声明的入口路径列表
   * 2. index.ts / index.js → 单入口
   * 3. 都没有 → 返回 null（不是 extension 目录）
   */
  private resolveExtensionEntries(dir: string): string[] | null {
    const packageJsonPath = join(dir, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const raw = readFileSync(packageJsonPath, 'utf-8')
        const pkg = JSON.parse(raw) as { pi?: { extensions?: string[] } }
        if (pkg.pi?.extensions?.length) {
          const resolved: string[] = []
          for (const extPath of pkg.pi.extensions) {
            const resolvedExtPath = resolve(dir, extPath)
            if (existsSync(resolvedExtPath)) {
              resolved.push(resolvedExtPath)
            }
          }
          if (resolved.length > 0) return resolved
        }
      } catch {
        // package.json 解析失败，继续尝试 index.ts/index.js
      }
    }

    const indexTs = join(dir, 'index.ts')
    if (existsSync(indexTs)) return [indexTs]
    const indexJs = join(dir, 'index.js')
    if (existsSync(indexJs)) return [indexJs]

    return null
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

  // ── Public helpers ──────────────────────────────────────────────

  /**
   * 验证包是否为有效的 pi extension。
   * 有效条件（满足任一）：
   * - keywords 包含 'pi-package'
   * - peerDependencies 包含含 'pi-coding-agent' 或 'pi-agent-core' 的包
   * - package.json 中有 'pi' manifest 字段
   */
  isValidPiExtension(pkgDir: string): boolean {
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
   * 保留 scope，仅去掉 pi- 前缀：
   * - @zhushanwen/pi-goal → @zhushanwen/goal
   * - pi-subagents → subagents
   * - @scope/subagents → @scope/subagents
   *
   * NOTE: Behavioral change from old version — scope is now preserved.
   * Old: @zhushanwen/pi-goal → goal (scope stripped)
   * New: @zhushanwen/pi-goal → @zhushanwen/goal (scope kept)
   * This allows scoped and unscoped packages with the same base name
   * to coexist without dedup collision.
   */
  /** Normalize extension name: keep scope, strip pi- prefix.
   *  e.g. "@zhushanwen/pi-goal" → "@zhushanwen/goal", "pi-goal" → "goal"
   *
   *  BREAKING CHANGE NOTE: versions prior to this change stripped the scope
   *  ("@zhushanwen/pi-goal" → "goal"). Existing disabled-packages.json entries
   *  may use the old format. If users report extensions re-enabling after upgrade,
   *  check disabled-packages.json for stale keys and run a one-time migration.
   */
  private normalizeExtName(name: string): string {
    const parts = name.split('/')
    const last = parts[parts.length - 1].replace(/^pi-/, '')
    if (parts.length > 1) {
      return parts.slice(0, -1).join('/') + '/' + last
    }
    return last
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
        if (!this.isValidPiExtension(entryPath)) continue
        result.set(this.normalizeExtName(entry), entryPath)
      }
      log.debug(`[extension-resolver] ${label}: found ${result.size} extensions in ${dir}`)
    } catch (e) {
      log.warn(`[extension-resolver] failed to scan ${label} dir ${dir}: ${e}`)
    }
  }
}
