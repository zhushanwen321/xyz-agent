/**
 * ExtensionResolver — 四源扫描与去重
 *
 * 扫描四个来源的 extension，按优先级去重后返回目录路径列表：
 *   npm (@zhushanwen/pi-*) > user > third-party > bundled
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// eslint-disable-next-line no-console
const log = {
  info: (...args: unknown[]) => console.log('[extension-resolver]', ...args),
  warn: (...args: unknown[]) => console.warn('[extension-resolver]', ...args),
  debug: (...args: unknown[]) => {},
}
/** 优先级：数值越小优先级越高（npm 最高） */
const PRIORITY_ORDER = ['npm', 'user', 'third-party', 'bundled'] as const
type SourceName = (typeof PRIORITY_ORDER)[number]

/** 扫描结果：extension name → 目录绝对路径 */
type ExtensionMap = Map<string, string>

export interface ExtensionPaths {
  extensionDirs: string[]
}

interface SourceMap {
  source: SourceName
  extensions: ExtensionMap
}

export class ExtensionResolver {
  /**
   * 解析所有 extension 路径，按优先级去重。
   * deduplicate() 按 PRIORITY_ORDER 升序遍历（高优先级先写入），first-write-wins。
   */
  resolve(projectRoot: string, packaged: boolean, userExtPaths: string[]): ExtensionPaths {
    const sources: SourceMap[] = []

    sources.push({ source: 'bundled', extensions: this.scanBundledExtensions(projectRoot, packaged) })
    sources.push({ source: 'third-party', extensions: this.scanThirdPartyExtensions() })
    if (userExtPaths.length > 0) {
      sources.push({ source: 'user', extensions: this.scanUserExtensions(userExtPaths) })
    }
    sources.push({ source: 'npm', extensions: this.scanNpmExtensions(projectRoot) })

    const deduped = this.deduplicate(sources)
    log.info(`[extension-resolver] resolved ${deduped.size} extensions from ${sources.length} sources`)
    return { extensionDirs: [...deduped.values()] }
  }

  /**
   * 扫描 node_modules/@zhushanwen/pi-* 包
   */
  scanNpmExtensions(projectRoot: string): ExtensionMap {
    const result: ExtensionMap = new Map()
    const scopeDir = join(projectRoot, 'node_modules', '@zhushanwen')

    if (!existsSync(scopeDir)) return result

    let dirEntries: string[]
    try {
      dirEntries = readdirSync(scopeDir)
    } catch (e) {
      log.warn(`[extension-resolver] failed to read ${scopeDir}: ${e}`)
      return result
    }

    for (const entry of dirEntries) {
      if (!entry.startsWith('pi-')) continue
      const pkgDir = join(scopeDir, entry)
      try {
        if (!statSync(pkgDir).isDirectory()) continue
      } catch {
        continue
      }
      // 使用目录名（不带 @zhushanwen/ scope）作为 key，与 bundled/third-party/user 一致
      const pkgJsonPath = join(pkgDir, 'package.json')
      let extName = entry
      try {
        const raw = readFileSync(pkgJsonPath, 'utf-8')
        const pkg = JSON.parse(raw) as { name?: string }
        // 从 scoped name 提取短名：@zhushanwen/pi-goal → pi-goal
        const shortName = (pkg.name ?? entry).replace(/^@[^/]+\//, '')
        extName = shortName || entry
      } catch {
        // package.json 不存在或解析失败，用目录名
        log.debug(`[extension-resolver] no package.json in ${pkgDir}, using dir name`)
      }
      result.set(extName, pkgDir)
    }

    return result
  }

  /**
   * 扫描 bundled extensions
   * - 打包模式：返回空（由 migrateToPiSubdir 同步到 third-party 目录）
   * - 开发模式：扫描 resources/pi/agent/extensions/
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
      // 使用目录名作为 key
      const parts = extPath.replace(/\\/g, '/').split('/')
      const dirName = parts[parts.length - 1] || extPath
      result.set(dirName, extPath)
    }

    return result
  }

  /**
   * 去重：按 PRIORITY_ORDER 升序遍历（高优先级在前），first-write-wins。
   * 高优先级先写入 Map，低优先级遇到已存在的 key 跳过。
   */
  deduplicate(sources: SourceMap[]): ExtensionMap {
    const merged: ExtensionMap = new Map()

    // 按优先级排序（npm=0 最先，bundled=3 最后）
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
        result.set(entry, entryPath)
      }
      log.debug(`[extension-resolver] ${label}: found ${result.size} extensions in ${dir}`)
    } catch (e) {
      log.warn(`[extension-resolver] failed to scan ${label} dir ${dir}: ${e}`)
    }
  }
}
