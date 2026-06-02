/**
 * ExtensionResolver — 四源扫描与去重
 *
 * 扫描四个来源的 extension，按优先级去重后返回目录路径列表：
 *   npm (@zhushanwen/pi-*) > user > third-party > bundled
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
   * 解析所有 extension 路径，按优先级去重
   */
  resolve(projectRoot: string, packaged: boolean, userExtPaths: string[]): ExtensionPaths {
    const sources: SourceMap[] = []

    // 按优先级从低到高添加，deduplicate 用 first-write-wins（高优先级后写覆盖低优先级）
    // bundled（最低优先级）
    sources.push({ source: 'bundled', extensions: this.scanBundledExtensions(projectRoot, packaged) })
    // third-party
    sources.push({ source: 'third-party', extensions: this.scanThirdPartyExtensions() })
    // user
    if (userExtPaths.length > 0) {
      sources.push({ source: 'user', extensions: this.scanUserExtensions(userExtPaths) })
    }
    // npm（最高优先级）
    sources.push({ source: 'npm', extensions: this.scanNpmExtensions(projectRoot) })

    const deduped = this.deduplicate(sources)
    return { extensionDirs: [...deduped.values()] }
  }

  /**
   * 扫描 node_modules/@zhushanwen/pi-* 包
   */
  scanNpmExtensions(projectRoot: string): ExtensionMap {
    const result: ExtensionMap = new Map()
    const scopeDir = join(projectRoot, 'node_modules', '@zhushanwen')

    if (!existsSync(scopeDir)) return result

    try {
      const entries = readdirSync(scopeDir)
      for (const entry of entries) {
        if (!entry.startsWith('pi-')) continue
        const pkgDir = join(scopeDir, entry)
        try {
          const stat = statSync(pkgDir)
          if (!stat.isDirectory()) continue
        } catch {
          continue
        }
        // 使用包名作为 key（不带 @zhushanwen/ 前缀）
        const pkgJsonPath = join(pkgDir, 'package.json')
        let extName = entry
        try {
          const raw = readFileSync(pkgJsonPath, 'utf-8')
          const pkg = JSON.parse(raw) as { name?: string; piExtension?: unknown }
          // 只包含声明了 piExtension 的包
          if (!pkg.piExtension) continue
          extName = pkg.name ?? entry
        } catch {
          continue
        }
        result.set(extName, pkgDir)
      }
    } catch {
      // node_modules/@zhushanwen 不可读
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

    this.scanDirectory(bundledDir, result)
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

    this.scanDirectory(thirdPartyDir, result)
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
        const stat = statSync(extPath)
        if (!stat.isDirectory()) continue
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
   * 去重：按 PRIORITY_ORDER 降序遍历（高优先级在前），first-write-wins
   * 高优先级先写入 Map，低优先级遇到已存在的 key 跳过
   */
  deduplicate(sources: SourceMap[]): ExtensionMap {
    const merged: ExtensionMap = new Map()

    // 按优先级从高到低排序（npm 最先）
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
  private scanDirectory(dir: string, result: ExtensionMap): void {
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry === 'shared') continue
        const entryPath = join(dir, entry)
        try {
          const stat = statSync(entryPath)
          if (!stat.isDirectory()) continue
        } catch {
          continue
        }
        // 使用目录名作为 extension name
        result.set(entry, entryPath)
      }
    } catch {
      // 目录不可读
    }
  }
}
