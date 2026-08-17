import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { XyzAgentPackageJson, PluginDescriptor, PluginState, PluginContributes, PluginSource } from './plugin-types.js'
import { checkPluginCompatibility } from './plugin-version-checker.js'

/**
 * 插件注册中心：扫描本地插件目录，解析 package.json 中的 xyzAgent manifest，
 * 产成 PluginDescriptor 缓存在内存。
 *
 * 扫描目录优先级：
 *   1. <configDir>/plugins/        （全局插件，configDir 由组合根注入）
 *   2. <projectRoot>/.xyz-agent/plugins/  （项目级插件）
 *   3. built-in 目录（resolveBuiltinPluginsDir，多运行形态候选探测，见其注释）
 */
export class PluginRegistry {
  private cache = new Map<string, PluginDescriptor>()
  private projectRoot: string
  private pluginsConfigDir: string

  /** @param projectRoot 项目根（项目级插件扫描用）
   *  @param pluginsConfigDir 全局配置根（~/.xyz-agent/，全局插件扫描用），由组合根注入。 */
  constructor(projectRoot: string, pluginsConfigDir: string) {
    this.projectRoot = projectRoot
    this.pluginsConfigDir = pluginsConfigDir
  }

  async scan(): Promise<PluginDescriptor[]> {
    const dirs: Array<{ path: string; source: PluginSource }> = [
      { path: join(this.pluginsConfigDir, 'plugins'), source: 'external' },
      { path: join(this.projectRoot, '.xyz-agent', 'plugins'), source: 'external' },
      { path: await this.resolveBuiltinPluginsDir(), source: 'built-in' },
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

  /**
   * 解析 built-in 插件目录（resources/plugins/，多运行形态候选探测）。
   *
   * projectRoot = runtime cwd（组合根 effectiveRoot），不同运行形态下仓库根/打包资源
   * 相对 cwd 的位置不同，按序探测候选目录、首个存在者胜出：
   *
   *   候选 1  <projectRoot>/resources/plugins
   *     - 打包形态：cwd=Resources/，electron-builder extraResources 拷贝目标即
   *       Resources/resources/plugins（electron-builder.yml `to: resources/plugins`）
   *     - cwd=仓库根：隔离 tsx 直跑（verify-plugin-e2e.sh）/ 本地 dist 运行
   *   候选 2  <projectRoot>/../../resources/plugins
   *     - pnpm dev：runtime cwd=apps/electron，仓库根在其上两层（与 runtime-env
   *       .getExtensionFilePath、extension-resolver.scanBundledExtensions 的 ../..
   *       推导同构）
   *
   * [HISTORICAL] dev 缺口（F4 修复）：dev 下 cwd=apps/electron，旧实现只扫
   * <projectRoot>/resources/plugins（不存在）→ built-in statusline 在 dev 从不被
   * 发现。候选探测同时覆盖「cwd=仓库根」与「cwd=apps/electron」两种 dev 形态，
   * 不依赖 isPackaged env（两打包形态均由候选 1 命中）。
   *
   * 全部候选缺失（如全新 checkout 未跑 prepare-builtin-plugins.sh）时返回候选 1，
   * 让 scan() 的 readdir 失败分支按既有语义静默跳过。
   */
  private async resolveBuiltinPluginsDir(): Promise<string> {
    const candidates = [
      join(this.projectRoot, 'resources', 'plugins'),
      resolve(this.projectRoot, '..', '..', 'resources', 'plugins'),
    ]
    for (const dir of candidates) {
      try {
        if ((await stat(dir)).isDirectory()) return dir
      } catch {
        // 候选不存在 → 试下一个
        continue
      }
    }
    return candidates[0]
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

    // 入口文件路径：manifest.main 缺省 index.js（向后兼容）。
    // pluginPath 必须指向具体入口文件而非插件目录——plugin-bootstrap 的 load 分支
    // 直接 `import(pluginPath)`，ESM 禁止目录导入（ERR_UNSUPPORTED_DIR_IMPORT），
    // 存目录会导致所有插件激活必炸（built-in statusline 曾因目录路径从未激活成功）。
    const main = manifest.main ?? 'index.js'
    const entryPath = resolve(fullPath, main)
    // 入口守卫：main 必须解析到插件目录内（拒绝 ../ 逃逸与绝对路径），
    // 防止插件声明越权入口 import 插件目录外的任意文件
    if (entryPath !== fullPath && !entryPath.startsWith(fullPath + sep)) {
      console.warn(`[plugin-registry] ${dirName}: main "${main}" escapes plugin directory, skipping`)
      return null
    }

    const descriptor: PluginDescriptor = {
      pluginId: dirName,
      version: pkg.version ?? '0.0.0',
      displayName: pkg.displayName ?? pkg.name ?? dirName,
      description: pkg.description ?? '',
      main,
      activationEvents,
      trustLevel: manifest.trustLevel ?? 'sandbox',
      status: compat.compatible ? ('UNLOADED' as PluginState) : ('DEPS_MISSING' as PluginState),
      contributes: manifest.contributes ?? {} as PluginContributes,
      permissions: manifest.permissions ?? [],
      engines: { 'xyz-agent': engineRange ?? '*' },
      pluginPath: entryPath,
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
