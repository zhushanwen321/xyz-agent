import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from '../../pi-config-bridge.js'
import type { XyzAgentPackageJson, PluginDescriptor, PluginState, PluginContributes, PluginSource } from './plugin-types.js'
import { checkPluginCompatibility } from './plugin-version-checker.js'

/**
 * 插件注册中心：扫描本地插件目录，解析 package.json 中的 xyzAgent manifest，
 * 产成 PluginDescriptor 缓存在内存。
 *
 * 扫描目录优先级：
 *   1. ~/.xyz-agent/plugins/        （全局插件）
 *   2. <projectRoot>/.xyz-agent/plugins/  （项目级插件）
 */
export class PluginRegistry {
  private cache = new Map<string, PluginDescriptor>()
  private projectRoot: string

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  async scan(): Promise<PluginDescriptor[]> {
    const dirs: Array<{ path: string; source: PluginSource }> = [
      { path: join(getConfigDir(), 'plugins'), source: 'external' },
      { path: join(this.projectRoot, '.xyz-agent', 'plugins'), source: 'external' },
      { path: join(this.projectRoot, 'resources', 'plugins'), source: 'built-in' },
    ]
    const results: PluginDescriptor[] = []
    for (const { path: dir, source } of dirs) {
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        // 目录不存在 → 跳过（首次运行时 ~/.xyz-agent/plugins/ 可能尚未创建）
        continue
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          const st = await stat(fullPath)
          if (!st.isDirectory()) continue
        } catch {
          console.warn(`[plugin-registry] cannot stat ${fullPath}, skipping`)
          continue
        }
        const descriptor = await this.parsePlugin(entry, fullPath, source)
        if (descriptor) results.push(descriptor)
      }
    }
    this.cacheDescriptors(results)
    return results
  }

  cacheDescriptors(descriptors: PluginDescriptor[]): void {
    for (const d of descriptors) this.cache.set(d.pluginId, d)
  }

  getDescriptor(pluginId: string): PluginDescriptor | undefined {
    return this.cache.get(pluginId)
  }

  getAllDescriptors(): PluginDescriptor[] {
    return [...this.cache.values()]
  }

  /** Remove a descriptor from the cache (used during uninstall) */
  removeDescriptor(pluginId: string): boolean {
    return this.cache.delete(pluginId)
  }

  async reload(): Promise<PluginDescriptor[]> {
    this.cache.clear()
    return this.scan()
  }

  private async parsePlugin(dirName: string, fullPath: string, source: PluginSource): Promise<PluginDescriptor | null> {
    const pkgPath = join(fullPath, 'package.json')
    let raw: string
    try {
      raw = await readFile(pkgPath, 'utf-8')
    } catch { return null }

    let pkg: XyzAgentPackageJson
    try {
      pkg = JSON.parse(raw)
    } catch {
      console.warn(`[plugin-registry] invalid JSON in ${pkgPath}, skipping`)
      return null
    }

    if (!pkg.xyzAgent || pkg.xyzAgent.manifestVersion !== 1) {
      console.warn(`[plugin-registry] ${dirName}: missing or invalid xyzAgent manifest, skipping`)
      return null
    }

    const manifest = pkg.xyzAgent
    const activationEvents = this.inferActivationEvents(manifest.activationEvents ?? [], manifest.contributes)

    const engineRange = pkg.engines?.['xyz-agent'] ?? '*'
    const compat = checkPluginCompatibility(typeof engineRange === 'string' ? engineRange : '*')

    const descriptor: PluginDescriptor = {
      pluginId: dirName,
      version: pkg.version ?? '0.0.0',
      displayName: pkg.displayName ?? pkg.name ?? dirName,
      description: pkg.description ?? '',
      main: manifest.main ?? 'index.js',
      activationEvents,
      trustLevel: manifest.trustLevel ?? 'sandbox',
      status: compat.compatible ? ('UNLOADED' as PluginState) : ('DEPS_MISSING' as PluginState),
      contributes: manifest.contributes ?? {} as PluginContributes,
      permissions: manifest.permissions ?? [],
      engines: { 'xyz-agent': engineRange ?? '*' },
      pluginPath: fullPath,
      source,
      extensionDependencies: manifest.extensionDependencies ?? [],
      ...(compat.compatible ? {} : { compatibilityError: compat.reason }),
    }

    if (!compat.compatible) {
      console.warn(`[plugin-registry] ${dirName}: ${compat.reason}`)
    }

    return descriptor
  }

  /**
   * 从 contributes.slashCommands 推断隐式 activationEvent，
   * 避免插件开发者手动声明每个命令对应的 onSlashCommand:xxx。
   */
  private inferActivationEvents(
    declared: string[],
    contributes?: PluginContributes,
  ): string[] {
    const events = [...declared]
    if (contributes?.slashCommands) {
      for (const cmd of contributes.slashCommands) {
        const event = `onSlashCommand:${cmd.name}`
        if (!events.includes(event)) events.push(event)
      }
    }
    if (contributes?.tools) {
      for (const tool of contributes.tools) {
        const event = `onToolCall:${tool.name}`
        if (!events.includes(event)) events.push(event)
      }
    }
    if (contributes?.hooks) {
      for (const hook of contributes.hooks) {
        if (!events.includes(hook)) events.push(hook)
      }
    }
    // Phase 1 不为 panels/statusBarItems 推断 activation events（无对应事件类型）
    // panels/statusBarItems 的激活由 Phase 3+ 的 UI 扩展机制处理
    return events
  }
}
