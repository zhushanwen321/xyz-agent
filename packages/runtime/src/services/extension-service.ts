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
import { join, resolve, basename, dirname, relative, isAbsolute, delimiter } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { ExtensionInfo } from '@xyz-agent/shared'
import { recommendedExtensions, mandatoryExtensions, isMandatoryExtension, BUILTIN_EXTENSION_FILES } from '@xyz-agent/shared'
import semver from 'semver'
import type { IInstaller, IExtensionResolver, DiscoveredExtension } from './ports/installer.js'
import { resolveExtensions, readPkgMeta, type ResolvedExtension } from './extension-filter.js'
import type { IExtensionSettings } from './ports/extension-settings.js'
import type { IConfigStore } from './ports/config.js'
import { isStrictlyUnder, isUnderOrEqual, extractRepoName, expandHome } from '../utils/path-utils.js'
import { toErrorMessage } from '../utils/errors.js'
import { isPackaged, getExtensionFilePath } from '../utils/runtime-env.js'
import { getExtensionsDir, getNpmDir, getTmpDir, getPiAgentDir } from '../infra/pi/pi-paths.js'

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

/**
 * W-SH-2 编译期一致性断言：extension-service 的 builtinExts 顺序必须与 shared 的
 * BUILTIN_EXTENSION_FILES 完全一致（name 字段引用常量做 SSOT）。若 shared 常量变更
 *（增删项/改顺序），下面类型断言会 tsc 报错，强制同步此处 path 推导逻辑。
 *
 * 断言顺序：[0]=xyz-agent-extension.js / [1]=xyz-system-prompt-extension.js /
 * [2]=xyz-client-msg-id-mapper.js（与 getExtensionFilePath 默认 + 显式 fileName 推导对应）。
 */
type _AssertBuiltinExtOrder<
  A extends string,
  B extends string,
  C extends string,
> = A extends 'xyz-agent-extension.js'
  ? B extends 'xyz-system-prompt-extension.js'
    ? C extends 'xyz-client-msg-id-mapper.js'
      ? true
      : never
    : never
  : never
// 索引按 BUILTIN_EXTENSION_FILES 元组顺序：0=主扩展 / 1=系统提示 / 2=消息 ID 映射器
const _BUILTIN_EXT_AGENT_EXT_IDX = 0
const _BUILTIN_EXT_SYS_PROMPT_IDX = 1
const _BUILTIN_EXT_MSG_MAPPER_IDX = 2
type _AssertBuiltinExtOrderCheck = _AssertBuiltinExtOrder<
  (typeof BUILTIN_EXTENSION_FILES)[typeof _BUILTIN_EXT_AGENT_EXT_IDX],
  (typeof BUILTIN_EXTENSION_FILES)[typeof _BUILTIN_EXT_SYS_PROMPT_IDX],
  (typeof BUILTIN_EXTENSION_FILES)[typeof _BUILTIN_EXT_MSG_MAPPER_IDX]
>

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
  /**
   * discovery.json SSOT 的访问 port（读 extensionDirs）。由 index.ts 注入（生产）。
   * 可选：测试场景可不注入，getExtensionPaths 时 discovery 目录为空数组。
   */
  configStore?: IConfigStore
  /** 用户安装的 extension 目录，默认 getExtensionsDir()（~/.xyz-agent/extensions） */
  extensionsDir?: string
  /** npm 安装目录，默认 getNpmDir()（~/.xyz-agent/npm） */
  npmDir?: string
  /** extension 安装临时目录，默认 getTmpDir()（~/.xyz-agent/tmp） */
  tmpDir?: string
}

export class ExtensionService {
  private readonly settingsDir: string
  private readonly installer: IInstaller
  private readonly resolver: IExtensionResolver
  private readonly extSettings: IExtensionSettings
  private readonly projectRoot: string
  private readonly packaged: boolean
  private readonly extensionsDir: string
  private readonly npmDir: string
  private readonly tmpDir: string
  /** discovery.json SSOT 访问 port（读 extensionDirs）。可选，测试可不注入。 */
  private readonly configStore?: IConfigStore

  /** 文件型 extension 路径（如 xyz-agent-extension.js），打包/开发模式不同 */
  private extensionFilePath: string

  /** 第二个文件型 extension 路径（xyz-system-prompt-extension.js），链式位置在 extensionFilePath 之后 */
  private systemPromptExtensionFilePath: string

  /** 第三个文件型 extension 路径（xyz-client-msg-id-mapper.js），建立 clientUuid↔userEntryId 映射 */
  private clientMsgIdMapperFilePath: string

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
    this.extensionsDir = options.extensionsDir ?? getExtensionsDir()
    this.npmDir = options.npmDir ?? getNpmDir()
    this.tmpDir = options.tmpDir ?? getTmpDir()
    this.configStore = options.configStore

    // 文件型 extension 路径
    this.extensionFilePath = getExtensionFilePath(this.projectRoot, this.packaged)
    // 第二个文件型 extension 路径（system-prompt 扩展，链式位置在 agent extension 之后）
    this.systemPromptExtensionFilePath = getExtensionFilePath(this.projectRoot, this.packaged, 'xyz-system-prompt-extension.js')
    // 第三个 builtin：client-msg-id-mapper（input hook 剥标记 + appendEntry 写映射，重开 session 回填 badge）
    this.clientMsgIdMapperFilePath = getExtensionFilePath(this.projectRoot, this.packaged, 'xyz-client-msg-id-mapper.js')

    // Cleanup orphaned temp directories from previous crashes (>24h old)
    // Defer to next tick to avoid blocking constructor
    setTimeout(() => this.cleanupOrphanedTempDirs(), 0)
  }

  private cleanupOrphanedTempDirs(): void {
    try {
      const tmpDir = this.tmpDir
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
      .map(p => p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
      .map(p => resolve(this.projectRoot, p))
  }

  /**
   * 读 discovery.json.extensionDirs，按绝对/相对路径分组 resolve。
   *
   * 绝对路径（如 ~/.pi/agent/extensions）：与 cwd 无关，全局有效 → 进 scanExtensions（ExtensionPage 可见）
   * 相对路径（如 .agents/extensions）：依赖 cwd，项目级 → 仅 session 启动时按 cwd resolve 加载
   *
   * ~/xxx 家目录前缀先 expandHome（否则 isAbsolute('~/...') false）。
   * configStore 未注入（测试场景）时返回两组皆空。
   */
  private resolveDiscoveryDirs(cwd?: string): { absolute: string[]; relative: string[] } {
    if (!this.configStore) return { absolute: [], relative: [] }
    const base = cwd ?? this.projectRoot
    const absolute: string[] = []
    const relative: string[] = []
    for (const p of this.configStore.getExtensionDirs()) {
      const expanded = expandHome(p)
      const resolved = isAbsolute(expanded) ? expanded : resolve(base, expanded)
      if (!existsSync(resolved)) {
        console.warn(`[extension-service] discovery extension dir not found, skipping: ${p} (resolved: ${resolved})`)
        continue
      }
      // 判断用 isAbsolute(expanded)（expandHome 后的原始路径是否绝对），不是 resolved：
      // 相对路径 resolve 后也变绝对了，必须在 resolve 前判断。
      if (isAbsolute(expanded)) {
        absolute.push(resolved)
      } else {
        relative.push(resolved)
      }
    }
    return { absolute, relative }
  }

  /**
   * 扫描所有 extension，返回 ExtensionInfo[]（全局视图，含绝对路径 discovery 扩展）。
   * 用 ExtensionResolver 扫描所有源，复用 resolveExtensions 判定 loadable 状态。
   * 保留 disabled 包（enabled:false），前端 ExtensionPage 据此渲染。
   *
   * 绝对路径 discovery 目录（如 ~/.pi/agent/extensions）与 cwd 无关，全局有效 → 进列表；
   * 相对路径 discovery 目录（如 .agents/extensions）依赖 cwd，项目级 → 仅 session 启动加载，不进全局视图。
   */
  async scanExtensions(): Promise<ExtensionInfo[]> {
    // 绝对路径 discovery 目录全局有效，进列表（相对路径是项目级，不进全局视图）
    const { absolute } = this.resolveDiscoveryDirs()
    const discovered = this.resolver.resolve(this.projectRoot, this.packaged, this.getUserExtensionPaths(), absolute).extensionDirs
    const { packages, disabled } = this.readSettingsState()
    const disabledSet = new Set(disabled)
    const autoUpgradeSet = new Set(this.extSettings.getAutoUpgrade())

    return this.assembleExtensionInfo(discovered, packages, disabledSet, autoUpgradeSet)
  }

  /**
   * 组装 ExtensionInfo 列表（scanExtensions 共用）。
   *
   * S1 修复：name/tier/loadable 复用 resolveExtensions 的结果（resolveExtensions 内部一次读盘
   * 推导），不再每个 ext 各自 readFileSync(pkgJson) + resolveExtension（又读一次）。
   * version/description/tools 仍需读 package.json（ResolvedExtension 未携带这些），用 readPkgMeta
   * 在此一处读，不扩散到 PresetService。
   */
  private assembleExtensionInfo(
    discovered: DiscoveredExtension[],
    packages: string[],
    disabledSet: Set<string>,
    autoUpgradeSet: Set<string>,
  ): ExtensionInfo[] {
    // 一次读盘推导 name/tier/loadable（S1：不再每个 ext 各自读 + resolveExtension 再读）
    const resolvedList = resolveExtensions(discovered, disabledSet)
    const resolvedByPath = new Map<string, ResolvedExtension>(resolvedList.map(r => [r.path, r]))

    const extensions: ExtensionInfo[] = []

    for (const ext of discovered) {
      const dir = ext.path
      const resolved = resolvedByPath.get(dir)!
      const name = resolved.name // 复用 resolveExtensions 已推导的 name（含 basename fallback + typeof 守卫）

      // version/description/tools 仍需读 package.json（ResolvedExtension 未携带这些），但只在此处读一次
      const meta = readPkgMeta(dir)
      const version = meta.version ?? ''
      const description = meta.description ?? ''
      let tools: string[] | undefined
      if (Array.isArray(meta.pi?.tools)) {
        tools = meta.pi!.tools!.filter((t): t is string => typeof t === 'string')
      }

      const sourceKey = `npm:${name}`
      const isUserInstalled = packages.includes(sourceKey)
      const isAutoUpgrade = autoUpgradeSet.has(sourceKey)

      // displayName 推导（展示用，不影响 disabled key / allowlist 匹配——那些用 name）：
      //   有 package.json name → 用 name（规范：纯包名 @scope/pi-xxx）
      //   无 package.json 的 index.ts/index.js 入口 → 父目录名（解决多目录 index.ts 重名）
      //   无 package.json 的单文件 → basename 去后缀
      const entryBasename = basename(dir)
      const displayName = typeof meta.name === 'string'
        ? name
        : entryBasename === 'index.ts' || entryBasename === 'index.js'
          ? basename(dirname(dir))
          : entryBasename.replace(/\.(ts|js)$/, '')

      extensions.push({
        name,
        displayName,
        dirName: basename(dir),
        version,
        description,
        path: dir,
        enabled: resolved.loadable, // 复用 resolveExtensions 的 loadable 判定
        // #4：mandatory 直接从 resolved.tier 推导（source 感知——discovery 源扩展即使 name 命中
        // mandatory SSOT 也不当 mandatory，tier 为 undefined；packages[]/npm 源 mandatory 包 tier 非 undefined）
        mandatory: resolved.tier !== undefined,
        tier: resolved.tier, // S10：tier 直接从 resolved 透传（天然正确）
        source: isUserInstalled ? 'user-installed' : ext.source === 'discovery' ? 'discovery' : 'built-in',
        autoUpgrade: isAutoUpgrade,
        ...(tools && { tools }),
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
   * 额外过滤 mandatory 项：即使将来 recommended-extensions.json 误含 mandatory 包，
   * 也不重复推荐（mandatory 由 boot 强制安装，无需出现在推荐区）。
   * 当前 recommended-extensions.json 为空——原推荐机制已停用，相关包（原推荐 + 后续新增）
   * 转入 mandatory-extensions.json 作为强制安装扩展（见该 mandatory SSOT，列表以它为准、不在此硬编码条目数）。
   */
  async getRecommendedExtensions(): Promise<Array<{ name: string; description: string; installed: boolean }>> {
    const installed = await this.scanExtensions()
    const installedNames = new Set(installed.map(e => e.name))
    return recommendedExtensions
      .filter(r => !isMandatoryExtension(r.name))
      .map(r => ({ ...r, installed: installedNames.has(r.name) }))
  }

  /**
   * 返回启用的 extension 路径列表（供 pi --extension 参数使用）。
   * 封装 ExtensionResolver.resolve() + 过滤禁用项 + 追加文件型 extension。
   *
   * @param cwd session cwd（相对路径 resolve 基准）。与 SessionService.getSkillPaths 对称：
   *   discovery.json 中的相对 extension 目录按 session cwd 解析（而非 runtime 进程 cwd），
   *   否则项目级 extension 目录会错位落到 app/resources 下被 existsSync 过滤掉。
   */
  async getExtensionPaths(cwd?: string): Promise<string[]> {
    const { discovered, disabledSet } = await this.getDiscoveredAndDisabled(cwd)
    // 委托给过滤管道（一次读盘，元数据透传）
    const resolved = resolveExtensions(discovered, disabledSet)
    const filtered = resolved.filter(r => r.loadable).map(r => r.path)
    // builtin extension 永远前置（设计文档 §2.3）
    filtered.unshift(...this.getBuiltinExtensionPaths())
    return filtered
  }

  /**
   * 供 PresetService 做 preset 二次筛选：返回原始发现结果（不含 builtin、不过滤、不加 preset 筛选）
   * + disabled 集合。
   *
   * M1 修复关键：preset-service 的 resolveExtensionPaths 需要原始 discovered（builtin 只在最终
   * prepend 一次）。若用 getExtensionPaths（已含 builtin），preset-service 再 prepend 一次会 double-builtin。
   * 此方法让 builtin 注入点唯一化（只在最终 prepend 一次），disabled 过滤本地完成。
   *
   * 已知限制：相对路径 discovery 扩展（项目级，如 .agents/extensions/foo）只在 session 启动时
   * 按 cwd 解析加载，不进 scanExtensions 全局视图（避免列表随 session 变化）。因此它们在 preset
   * allowlist 模式下会因 name 不在 allowedExtensions 被排除，用户无法通过 UI 勾选。
   * 这是边缘场景（相对路径 discovery 少见），符合"前端不可见的扩展不参与 preset 管控"的一致性。
   * 彻底解决需引入 session 级扩展列表（getProjectExtensions 接线），本次不做。
   *
   * @param cwd session cwd（相对 discovery 目录的 resolve 基准）
   */
  async getDiscoveredAndDisabled(cwd?: string): Promise<{ discovered: DiscoveredExtension[]; disabledSet: Set<string> }> {
    const { absolute, relative } = this.resolveDiscoveryDirs(cwd)
    // session 启动需要全部 discovery 扩展：绝对路径（全局）+ 相对路径（按 cwd resolve）
    const discoveryDirs = [...absolute, ...relative]
    const discovered = this.resolver.resolve(this.projectRoot, this.packaged, this.getUserExtensionPaths(), discoveryDirs).extensionDirs
    const { disabled } = this.readSettingsState()
    return { discovered, disabledSet: new Set(disabled) }
  }

  /**
   * 返回 builtin 文件型 extension 的绝对路径（existsSync 过滤后）。
   *
   * 设计文档 §2.3：3 个 builtin（xyz-agent-extension.js / xyz-system-prompt-extension.js /
   * xyz-client-msg-id-mapper.js）永远注入，不受 preset.extensionMode 影响。
   *
   * 提取自原 getExtensionPaths L318-333 的内联 builtinExts 数组 + 过滤循环（行为不变）。
   * 公开方法供 PresetService.resolveExtensionPaths 复用，避免重复 builtin 逻辑。
   *
   * 顺序约束：system-prompt 扩展必须在 agent extension 之后（spec §4 链式位置——
   * 最后追加 → 链上靠后，快照≈最终生效值）。client-msg-id-mapper 位置无关，追加末尾稳定。
   */
  getBuiltinExtensionPaths(): string[] {
    // W-SH-2：name 字段引用 shared 常量 BUILTIN_EXTENSION_FILES，保证此处与 shared SSOT 一致。
    // 用一致性断言锁死顺序（编译期检查，若 shared 常量变更此处会 tsc 报错提醒同步）。
    const builtinExts: Array<{ path: string; name: string }> = [
      { path: this.extensionFilePath, name: BUILTIN_EXTENSION_FILES[0] },
      { path: this.systemPromptExtensionFilePath, name: BUILTIN_EXTENSION_FILES[1] },
      { path: this.clientMsgIdMapperFilePath, name: BUILTIN_EXTENSION_FILES[2] },
    ]
    const paths: string[] = []
    for (const ext of builtinExts) {
      if (existsSync(ext.path)) {
        paths.push(ext.path)
      } else if (this.packaged) {
        // W-RT-7：packaged 模式下 builtin 文件缺失 = 打包错误（installer 漏拷文件），
        // fail-fast 抛错让用户/CI 立即感知，而非静默降级（builtin 缺失会导致系统提示词/
        // msg id 映射失效，pi 行为严重退化）。dev 模式仍只 warn（路径漂移常见，非致命）。
        throw new Error(`[extension] builtin extension missing in packaged build: ${ext.name} (path: ${ext.path})`)
      } else {
        // existsSync 为 false 时 warn（防 dev 模式路径漂移静默失效，与 getSkillPaths L703 同模式）。
        log.warn(`builtin extension not found, skipping: ${ext.name} (path: ${ext.path})`)
      }
    }
    return paths
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
      const npmDir = this.npmDir

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
      // mandatory 包不可卸载
      if (isMandatoryExtension(name)) {
        throw new ExtensionInstallError(
          'mandatory_cannot_uninstall',
          `Mandatory extension cannot be uninstalled: ${name}`,
          'This extension is required by the application and cannot be removed.',
        )
      }
      // 先扫描已安装列表，按 name 查找 extension 的路径
      const installed = await this.scanExtensions()
      const target = installed.find((e) => e.name === name)
      const thirdPartyDir = this.extensionsDir

      // local-dir / git 安装的 extension 在 ~/.xyz-agent/pi/agent/extensions/ 下。
      // finishInstall 时只 cpSync 到此目录，未记录到 settings.json packages[]——
      // 卸载必须 rmSync 目录，否则 resolver 会重新发现它。
      if (target?.path && isUnderOrEqual(thirdPartyDir, target.path)) {
        rmSync(target.path, { recursive: true, force: true })
      }

      // npm 安装的 extension：从 settings packages[] 移除 + 删 node_modules
      const npmDir = this.npmDir
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
   *
   * #2 修复：disabled key 按扩展来源命名空间隔离——discovery 源用 'discovery:' 前缀，其余源用
   * 'npm:' 前缀（与 resolveExtension 的 disabledKey 推导对齐）。内部查 scanExtensions 取该扩展的
   * source（不改 WS 协议/前端），查不到则 fallback 'npm:'（与历史行为兼容）。
   */
  async toggleExtension(name: string, enabled: boolean): Promise<void> {
    // 查扩展来源，决定 disabled key 前缀（npm: vs discovery:）。scanExtensions 的 source 判定
    // 已通过 assembleExtensionInfo 推导（resolver 发现源）。查不到（异常）则 fallback 'npm'。
    const extensions = await this.scanExtensions()
    const ext = extensions.find(e => e.name === name)
    const source = ext?.source === 'discovery' ? 'discovery' : 'npm'
    // mandatory 扩展不可禁用（与 uninstallExtension 守卫对称，避免 UI 禁用但 getExtensionPaths
    // 仍强加载的状态分离）。用 scanExtensions 的 mandatory 判定（已 source 感知：discovery 源扩展
    // 即使 name 命中 mandatory SSOT 也不当 mandatory）。查不到时 fallback 到 isMandatoryExtension。
    if (!enabled && (ext?.mandatory ?? isMandatoryExtension(name))) {
      throw new ExtensionInstallError(
        'mandatory_cannot_disable',
        `Mandatory extension cannot be disabled: ${name}`,
        'This extension is required by the application and cannot be disabled.',
      )
    }
    // #2：disabled key 按 source 命名空间隔离（discovery 扩展用 'discovery:' 前缀，避免与 npm 扩展串扰）
    const disabledKey = source === 'discovery' ? `discovery:${name}` : `npm:${name}`
    await this.extSettings.setEnabled(disabledKey, enabled)
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
      const npmDir = this.npmDir
      await this.installAndValidate(name, npmDir, 'upgrade')

      // 从 node_modules/<name>/package.json 读取实际安装版本，
      // 避免因 TOCTOU 与 registry dist-tags.latest 不一致
      const actualVersion = this.readInstalledVersion(name, npmDir)
      return { upgraded: true, from: currentVersion, to: actualVersion || latestVersion }
    })
  }

  /**
   * 确保 mandatory 扩展已安装。runtime boot 时调用（checkAndAutoUpgrade 之前）。
   * 对 mandatoryExtensions SSOT 中每个包：已装则跳过，未装则 installExtension + setAutoUpgrade。
   * 失败不抛错（记日志），不阻塞启动。与 checkAndAutoUpgrade 失败策略一致。
   *
   * 另外清理 disabled-packages.json 中的 mandatory 残留：某扩展可能在升格 mandatory 之前
   * 被用户禁用过，disabled 状态会遗留。getExtensionPaths 会无视 disabled 强加载 mandatory，
   * 但残留的 disabled 记录会让 scanExtensions 报 enabled:false + mandatory:true 的不一致状态
   * （UI 显示禁用态但开关已隐藏）。boot 时清除这些残留，保证 mandatory 包 enabled 始终为 true。
   */
  async ensureMandatoryExtensions(): Promise<Array<{ name: string; installed: boolean; error?: string }>> {
    const extensions = await this.scanExtensions()
    const installedNames = new Set(extensions.map(e => e.name))
    const disabled = this.extSettings.getDisabled()
    const results: Array<{ name: string; installed: boolean; error?: string }> = []

    for (const ext of mandatoryExtensions) {
      const source = `npm:${ext.name}`
      // 清理 disabled 残留（无论是否已安装）——mandatory 包不应处于 disabled 状态
      if (disabled.includes(source)) {
        try {
          await this.extSettings.removeDisabled(source)
        } catch (e) {
          log.warn(`[extension-service] mandatory clear-disabled failed for ${ext.name}: ${toErrorMessage(e)}`)
        }
      }
      if (installedNames.has(ext.name)) {
        results.push({ name: ext.name, installed: true })
        continue
      }
      try {
        await this.installExtension(source)
        await this.extSettings.setAutoUpgrade(source, true)
        results.push({ name: ext.name, installed: true })
      } catch (e) {
        log.warn(`[extension-service] mandatory install failed for ${ext.name}: ${toErrorMessage(e)}`)
        results.push({ name: ext.name, installed: false, error: toErrorMessage(e) })
      }
    }
    return results
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
    // 展开 ~ / ~user 为 home 目录（Node.js path.resolve 不认 ~，会当字面量拼到 cwd 上）
    const expanded = sourcePath.startsWith('~')
      ? join(homedir(), sourcePath.slice(1))
      : sourcePath
    const absPath = resolve(expanded)

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
    const tmpParent = this.tmpDir
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
      // dirName 改为相对于 tempDir 的路径，使 finishInstall 能正确定位嵌套 extension。
      // discoverExtensions 返回的 dirName 是 basename（如 "pi-subagent-workflow"），
      // 但当源目录是包含多个 extension 的父目录时，实际路径是 tempDir/<source>/pi-subagent-workflow。
      // 用 path 字段（绝对路径）计算相对路径，finishInstall 的 join(tempDir, relPath) 就能命中。
      for (const c of candidates) {
        if (c.path) {
          c.dirName = relative(tempDir, c.path)
        }
      }
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
    const tmpParent = this.tmpDir
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
      // dirName 改为相对于 tempDir 的路径（同 installLocalDirectory）
      for (const c of candidates) {
        if (c.path) {
          c.dirName = relative(tempDir, c.path)
        }
      }
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

    // Validate selected: relative paths allowed (nested extension collections),
    // but no path traversal (..) or absolute paths.
    // dirName is relative to tempDir — discoverExtensions computes it via relative(tempDir, path).
    for (const dirName of selected) {
      if (dirName.includes('..') || isAbsolute(dirName) || dirName.includes('\\')) {
        throw new Error(`Invalid extension dirName: "${dirName}"`
          + ' — must be a relative path without traversal')
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

    const extensionsDir = this.extensionsDir
    mkdirSync(extensionsDir, { recursive: true })

    for (const dirName of selected) {
      const srcDir = join(tempDir, dirName)
      // destDir 用 basename —— dirName 可能是嵌套相对路径（如 "extensions/pi-subagent-workflow"），
      // 但安装目标应平铺在 extensions/ 下，不保留源目录层级。
      const destDir = join(extensionsDir, basename(dirName))
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

    // 装后配置迁移（best-effort）：包声明 pi.migrate 时执行其幂等迁移脚本，
    // 把历史路径的配置文件搬到 <agentDir>/config/<简名>.json。
    // 覆盖全部安装/升级路径（installExtension / upgradeExtension 都经此方法）。
    await this.runConfigMigration(pkgInstallDir)
  }

  /**
   * 执行包声明的配置迁移脚本（package.json `pi.migrate`，相对路径）。
   * best-effort：脚本缺失/执行失败仅记日志，不阻断安装结果——
   * 迁移脚本自身幂等，下次安装/升级会重试。
   */
  private async runConfigMigration(pkgInstallDir: string): Promise<void> {
    try {
      const pkgPath = join(pkgInstallDir, 'package.json')
      if (!existsSync(pkgPath)) return
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { pi?: { migrate?: unknown } }
      const migrateRel = pkg.pi?.migrate
      if (typeof migrateRel !== 'string' || !migrateRel) return
      const scriptPath = resolve(pkgInstallDir, migrateRel)
      if (!existsSync(scriptPath)) {
        log.warn(`[extension-service] package declares pi.migrate but script not found: ${scriptPath}`)
        return
      }
      await this.installer.runMigrateScript(scriptPath, getPiAgentDir())
      log.info(`[extension-service] config migration executed: ${scriptPath}`)
    } catch (e) {
      // best-effort：迁移失败不影响安装结果（脚本幂等，下次升级重试）
      log.warn(`[extension-service] config migration failed (non-fatal): ${toErrorMessage(e)}`)
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
        displayName: info.name,
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
            displayName: info.name,
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
