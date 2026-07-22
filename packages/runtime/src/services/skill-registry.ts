/**
 * SkillRegistry —— skill 缓存 + 文件监听（W1）。
 *
 * 职责：
 * - 启动期扫描全局 skill 目录（piAgentDir/skills、configDir/skills、discovery.skillDirs），
 *   缓存为 globalCache，供 landing 浮层 / 命令源即时读取（不阻塞 UI）。
 * - 项目级 skill 懒加载：首次 getProjectSkills(cwd) 时扫描该 cwd 下 skill，挂 chokidar watcher，
 *   命中缓存后二次调用零开销。不同 cwd 的 projectCache 互不污染。
 * - chokidar 监听目录变动，300ms debounce 后重扫缓存并经 onChange 回调通知上游（renderer 刷新）。
 *
 * 设计取舍：
 * - scanFn 注入：测试用 _scanFn mock 扫描逻辑（U2 验证懒加载 + 缓存命中）；生产用默认实现，
 *   即 ConfigService.loadSkills（已封装优先级合并 / 容器目录遍历 / sources badge 链）。
 * - changeHandler 拿 affectedSessionIds（getActiveSessionIds 返回当前活跃 session 列表），
 *   由调用方按 sessionId 路由刷新。session 级状态隔离（架构约定 #7）的延伸：skill 变更广播
 *   也必须带 sessionId，故 _notifyGlobalChange 传整个活跃列表，上游自行过滤。
 */
import { watch, type FSWatcher } from 'chokidar'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillInfo } from '@xyz-agent/shared'
import { resolveGlobalSkillDirs, resolveProjectSkillDirs } from './skill-dirs.js'
import type { IConfigStore } from './ports/config.js'

/**
 * skill 扫描函数签名：给定 projectRoot（项目根 / cwd），返回该根下解析出的 skill 列表。
 * 全局扫描时 projectRoot 传空串或配置根目录——默认实现（ConfigService.loadSkills）对
 * projectRoot 只用于解析 discovery.json 相对路径，全局目录均为绝对路径故不受影响。
 */
export type SkillScanFn = (projectRoot: string) => Promise<SkillInfo[]>

/** configStore 的窄接口（与 PiConfigStore 对齐：无参 getSkillPaths / getPiAgentDir）。 */
export interface SkillRegistryConfigStore {
  /** discovery.json skillDirs（全局，无 cwd 参数）。 */
  getSkillPaths(): string[]
  /** pi agent 配置目录（~/.xyz-agent/pi/agent）。 */
  getPiAgentDir(): string
}

/** sessionService 的窄接口：查活跃 session 列表 + 按 sid 查 cwd（项目 skill 变更定位受影响 session）。 */
export interface SkillRegistrySessionService {
  getActiveSessionIds(): string[]
  getSessionCwd?(sessionId: string): string | undefined
}

export interface SkillRegistryOptions {
  configStore: SkillRegistryConfigStore
  /** xyz-agent 配置根目录（~/.xyz-agent/），用于推导全局 skill 目录 configDir/skills。 */
  configDir: string
  sessionService: SkillRegistrySessionService
  /**
   * 测试注入：覆盖默认扫描逻辑。默认实现复用 ConfigService.loadSkills（优先级合并 + 容器遍历）。
   * 注入时单元测试可断言调用次数（U2 懒加载 + 缓存命中）。
   */
  _scanFn?: SkillScanFn
}

/** debounce 间隔（ms）：文件变动密集时合并为一次重扫，避免短时间多次扫描开销。 */
const DEBOUNCE_MS = 300

/** 全局 watcher 的 debounce key（与项目级 cwd key 区分）。 */
const GLOBAL_KEY = '__global__'

/**
 * chokidar ignore 兜底：排除常见构建产物 / 依赖大目录（node_modules / dist / build / .git /
 * .next / coverage / out）。watch 范围已收窄到 skill 子目录，此为防御性兜底（容器目录意外混入
 * 这些目录时不爆 fd）。不忽略点目录——.agents/.pi/.xyz-agent 等是合法 skill 路径，原实现的通用
 * 点文件忽略 `(^|[\/\\])\..` 会连这些一起过滤掉，违背「watch 范围 = scan 范围」原则。
 */
const WATCH_IGNORED = /(^|[\/\\])(node_modules|dist|build|\.git|\.next|coverage|out)([\/\\]|$)/

/**
 * watcher 连续同类错误熔断阈值：达到则 close 该 watcher。背景：chokidar 遇 EMFILE 会自动重试 watch，
 * 但 fd 已耗尽时重试必再失败 → 死循环刷屏（2026-07-22 事故中 10899 次，撑账 2.9MB stderr）。
 * 熔断后停止重试，释放该 watcher 占用的句柄，让 pi spawn 等关键操作能拿到 fd。
 */
const MAX_WATCHER_ERRORS = 5

/**
 * SkillRegistry：全局 + 项目级 skill 缓存 + chokidar 文件监听。
 *
 * 生命周期：
 * - initGlobal()：组合根在 server.start 后调用，扫描全局目录 + 挂全局 watcher。
 * - getProjectSkills(cwd)：按需懒扫描 + 挂项目 watcher，命中缓存直接返回。
 * - dispose()：关闭所有 watcher（测试 / shutdown 时调）。
 */
export class SkillRegistry {
  private globalCache: SkillInfo[] = []
  private readonly projectCache = new Map<string, SkillInfo[]>()
  private readonly projectWatchers = new Map<string, FSWatcher>()
  /**
   * 进行中的 getProjectSkills Promise，按 cwd 去重（防 TOCTOU 竞态导致重复挂 watcher）。
   * 背景：缓存守卫在 await 之前，并发同 cwd 请求会各自走 scanFn + watch()，第二个 set 覆盖丢掉
   * 第一个 watcher（永不 close → fd 泄漏，正是本 PR 要消除的故障类别）。in-flight Promise 让并发
   * 调用共享同一次 scan + watch。
   */
  private readonly projectInFlight = new Map<string, Promise<SkillInfo[]>>()
  private globalWatcher: FSWatcher | null = null
  private readonly changeHandlers = new Set<(affectedSessionIds: string[]) => void>()
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>()
  private readonly scanFn: SkillScanFn

  constructor(private readonly options: SkillRegistryOptions) {
    this.scanFn = options._scanFn ?? this.defaultScanFn.bind(this)
  }

  /**
   * 启动期扫描全局 skill 目录并缓存 + 挂全局 watcher。
   * 必须在 server.start 后调用（组合根 index.ts 编排）。
   */
  async initGlobal(): Promise<void> {
    this.globalCache = await this.scanFn('')
    // watch 范围 = scan 范围（SSOT）：只 watch 实际存在的全局 skill 目录，不递归 watch 整个父目录。
    const dirs = resolveGlobalSkillDirs(this.options.configStore, this.options.configDir).filter(d => existsSync(d))
    if (dirs.length > 0) {
      // 幂等防护：若已存在 globalWatcher（重试逻辑/测试重复调用），先 close 旧的避免泄漏。
      this.globalWatcher?.close().catch(() => {})
      this.globalWatcher = watch(dirs, {
        ignored: WATCH_IGNORED,
        ignoreInitial: true,
        persistent: true,
      })
      this.setupWatcher(this.globalWatcher, 'global', GLOBAL_KEY, async () => {
        this.globalCache = await this.scanFn('')
        await this.notifyGlobalChange()
      })
    }
  }

  /** 当前全局 skill 缓存（启动期扫描结果，watcher 变动后自动刷新）。 */
  getGlobalSkills(): SkillInfo[] {
    return this.globalCache
  }

  /**
   * 取指定项目根下的 skill 列表。首次扫描 + 挂 watcher + 缓存；后续命中缓存零开销。
   * 不同 cwd 互不污染（projectCache 按 cwd 分区，架构约定 #7.6 Map 分区范式）。
   *
   * 并发安全：用 in-flight Promise Map 防止 TOCTOU 竞态。若同一 cwd 的多个请求并发到达
   * （多 panel / 多窗口同 cwd），它们共享同一次 scanFn + watch()，不会各自创建 watcher
   * 导致第二个 set 覆盖丢掉第一个 watcher（fd 泄漏）。
   *
   * W3 缓存命中补查：首次扫描时项目 skill 目录可能不存在（被 existsSync 过滤，没挂 watcher），
   * 后来用户创建了该目录——缓存命中路径补一次轻量检查，发现「应 watch 但无 watcher」的目录时
   * 异步补挂 watcher + 重扫刷新缓存（不阻塞当前返回，刷新完经 notifyProjectChange 通知上游）。
   */
  getProjectSkills(cwd: string): Promise<SkillInfo[]> {
    const cached = this.projectCache.get(cwd)
    if (cached) {
      // W3：补查首次扫描时不存在、后来用户创建的 skill 目录。检测到则异步补挂 watcher + 重扫缓存，
      // 不阻塞当前返回（返回缓存旧值），重扫完成后 notifyProjectChange 通知上游刷新。
      const dirs = resolveProjectSkillDirs(cwd, this.options.configStore).filter(d => existsSync(d))
      const existingWatcher = this.projectWatchers.get(cwd)
      if (dirs.length > 0 && !existingWatcher) {
        void this.refreshProjectWatcher(cwd, dirs)
      }
      return Promise.resolve(cached)
    }

    const inFlight = this.projectInFlight.get(cwd)
    if (inFlight) return inFlight

    const p = (async () => {
      const skills = await this.scanFn(cwd)
      this.projectCache.set(cwd, skills)
      // 挂项目 watcher：watch 范围 = scan 范围（SSOT），只 watch 实际存在的项目 skill 子目录
      // （.xyz-agent/skills、discovery 相对路径 resolve 后），不递归 watch 整个 cwd。
      // 原实现 watch 整个 cwd → cwd 为 home 目录时 chokidar 递归 watch 几十万文件 → EMFILE fd 耗尽
      // → pi spawn EBADF → 发消息/读历史全挂 + runtime 崩溃（2026-07-22 事故根因）。
      const dirs = resolveProjectSkillDirs(cwd, this.options.configStore).filter(d => existsSync(d))
      if (dirs.length > 0) {
        this.setupProjectWatcher(cwd, dirs)
      }
      // dirs 为空（项目无 skill 目录）时不挂 watcher：无 skill 可监听，缓存已 set（上面 scan 结果），返回即可。

      return skills
    })().finally(() => {
      this.projectInFlight.delete(cwd)
    })

    this.projectInFlight.set(cwd, p)
    return p
  }

  /**
   * 挂项目 watcher（getProjectSkills 首次挂载与 refreshProjectWatcher 补挂共用，避免重复代码）。
   * watch 范围 = scan 范围（SSOT）：只 watch 传入的实际存在项目 skill 子目录。
   */
  private setupProjectWatcher(cwd: string, dirs: string[]): void {
    const watcher = watch(dirs, {
      ignored: WATCH_IGNORED,
      ignoreInitial: true,
      persistent: true,
    })
    this.setupWatcher(watcher, `project:${cwd}`, cwd, async () => {
      this.projectCache.set(cwd, await this.scanFn(cwd))
      await this.notifyProjectChange(cwd)
    })
    this.projectWatchers.set(cwd, watcher)
  }

  /**
   * 补挂项目 watcher + 重扫缓存 + 通知上游（W3）。
   * 场景：首次扫描时 skill 目录不存在（无 watcher），后来用户创建了该目录——本方法补挂 watcher
   * 让后续变动可监听，并立即重扫一次刷新缓存（新出现的 skill 进缓存），最后 notifyProjectChange
   * 通知上游刷新到最新状态。setupProjectWatcher 同步完成 watcher 注册（防并发补挂重复），重扫异步。
   */
  private async refreshProjectWatcher(cwd: string, dirs: string[]): Promise<void> {
    this.setupProjectWatcher(cwd, dirs)
    this.projectCache.set(cwd, await this.scanFn(cwd))
    await this.notifyProjectChange(cwd)
  }

  /**
   * 注册 skill 变更回调。返回 unsubscribe 函数（组件卸载时调，防泄漏）。
   * 回调参数 affectedSessionIds：全局变动传所有活跃 session；项目变动传 cwd 匹配的 session。
   */
  onChange(handler: (affectedSessionIds: string[]) => void): () => void {
    this.changeHandlers.add(handler)
    return () => {
      this.changeHandlers.delete(handler)
    }
  }

  /**
   * 通知上游：全局 skill 变动。affectedSessionIds = 所有活跃 session（全局变动影响所有人）。
   * 前缀 _ 表示测试可直调（U3 模拟全局目录变动触发通知）。
   */
  async notifyGlobalChange(): Promise<void> {
    const ids = this.options.sessionService.getActiveSessionIds()
    for (const handler of this.changeHandlers) {
      handler(ids)
    }
  }

  /**
   * 通知上游：指定 cwd 的项目 skill 变动。affectedSessionIds = cwd 匹配的活跃 session。
   */
  async notifyProjectChange(cwd: string): Promise<void> {
    const allIds = this.options.sessionService.getActiveSessionIds()
    const getSessionCwd = this.options.sessionService.getSessionCwd
    const affected = getSessionCwd
      ? allIds.filter(sid => getSessionCwd(sid) === cwd)
      : allIds
    for (const handler of this.changeHandlers) {
      handler(affected)
    }
  }

  // 测试兼容别名（保持测试用 _notifyGlobalChange 不破坏，内部转发到 notifyGlobalChange）
  async _notifyGlobalChange(): Promise<void> {
    return this.notifyGlobalChange()
  }

  /** 关闭所有 watcher（全局 + 项目级）。shutdown / 测试清理时调。 */
  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    this.globalWatcher?.close().catch(() => {})
    this.globalWatcher = null
    for (const watcher of this.projectWatchers.values()) {
      watcher.close().catch(() => {})
    }
    this.projectWatchers.clear()
  }

  /**
   * 统一设置 watcher 的 error 处理（熔断）+ all 事件（debounce 重扫）。
   *
   * 熔断：watcher 连续同类错误（如 EMFILE）达 MAX_WATCHER_ERRORS 次时主动 close 该 watcher。
   * 背景：chokidar 遇 EMFILE 会自动重试 watch，但 fd 已耗尽时重试必再失败 → 死循环刷屏（事故中
   * 10899 次）。熔断后停止重试，释放该 watcher 占用的句柄，让 pi spawn 等关键操作能拿到 fd。
   *
   * label：日志标识（'global' / 'project:<cwd>'）。debounceKey：debounce 分区 key。rescan：变动时的重扫回调。
   */
  private setupWatcher(
    watcher: FSWatcher,
    label: string,
    debounceKey: string,
    rescan: () => Promise<void>,
  ): void {
    let errorCount = 0
    let lastCode = ''
    watcher.on('error', (e: unknown) => {
      const err = e as NodeJS.ErrnoException
      const code = err?.code ?? 'UNKNOWN'
      if (code === lastCode) {
        errorCount++
      } else {
        errorCount = 1
        lastCode = code
      }
      if (errorCount >= MAX_WATCHER_ERRORS) {
        console.error(
          `[skill-registry] ${label} watcher circuit-break: ${errorCount} consecutive ${code} errors, closing watcher`,
        )
        // 熝断后摘除 listener + 从 watchers Map 删除引用，避免后续同类错误反复调 close()
        // （S2）以及 dispose 时对已关闭 watcher 重复 close。注意：熔断后该 cwd 的 skill
        // 列表将不再自动刷新，需重启 session 才能恢复——这是 fd 耗尽场景下的安全网取舍。
        watcher.removeAllListeners('error')
        watcher.removeAllListeners('all')
        watcher.close().catch(() => {})
        if (debounceKey !== GLOBAL_KEY) {
          this.projectWatchers.delete(debounceKey)
        } else if (this.globalWatcher === watcher) {
          this.globalWatcher = null
        }
        // W4：熔断后推终态通知——让上游（renderer）刷新到当前缓存状态（最后一次已知值），
        // 避免 watcher 已停但 skill 列表与磁盘发散而上游无感知。setupWatcher 同步、notify 异步，
        // 用 void 前缀不阻塞 error 回调。debounceKey === GLOBAL_KEY 走全局通知，否则按 cwd 通知。
        if (debounceKey === GLOBAL_KEY) {
          void this.notifyGlobalChange()
        } else {
          void this.notifyProjectChange(debounceKey)
        }
        lastCode = ''
        errorCount = 0
      } else {
        console.error(`[skill-registry] ${label} watcher error (${errorCount}/${MAX_WATCHER_ERRORS} ${code}):`, err)
      }
    })
    watcher.on('all', () => {
      void this.debounce(debounceKey, rescan)
    })
  }

  // ── 内部工具 ──────────────────────────────────────────────────

  /**
   * 默认扫描实现：复用 ConfigService.loadSkills（封装优先级合并 / 容器目录遍历 / sources badge 链）。
   *
   * W2：configStore 用构造期注入的 options.configStore（scanner↔watcher SSOT 一致——两者都从同一份
   * configStore 读目录发现，不再各自 new PiConfigStore 导致隐式分叉）。动态 import ConfigService
   * 避免顶层硬依赖（循环依赖防护 + 测试隔离）。
   *
   * S5：全局扫描（projectRoot 为空串）时**不**传 process.cwd()——否则 loadSkills 会把 process.cwd()
   * 下的项目 skill（.xyz-agent/skills 等）扫进 globalCache，这些条目进了 globalCache 却不被全局
   * watcher 监听（全局 watch 范围 = resolveGlobalSkillDirs，不含项目目录），导致缓存与磁盘发散。
   * 改用一个 os.tmpdir() 下不存在的子路径作为 root：loadSkills 的全局目录（绝对路径）正常扫，
   * 项目目录（相对该 root resolve）全部不存在 → 不扫。不真创建该临时目录。
   *
   * projectRoot 非空（项目扫描）：传 cwd（解析 discovery.json 相对路径的基准）。
   */
  private async defaultScanFn(projectRoot: string): Promise<SkillInfo[]> {
    const { ConfigService } = await import('./config-service.js')
    // ConfigService 构造函数要求完整 IConfigStore（含 provider/agent CRUD 等），而 options.configStore
    // 是窄接口 SkillRegistryConfigStore（仅 getSkillPaths / getPiAgentDir）。loadSkills 内部实际只
    // 调这两个方法（经 resolveGlobalSkillDirs / resolveProjectSkillDirs），故运行时安全但类型不兼容——
    // 用 unknown 中转 cast，避免 any（架构约定：禁 any）。
    const configStore = this.options.configStore as unknown as IConfigStore
    // S5：全局扫描用不存在的 root，让 loadSkills 只扫全局目录，避免 process.cwd() 项目 skill 混入 globalCache。
    const root = projectRoot || join(tmpdir(), `skill-registry-global-scan-${process.pid}`)
    const configService = new ConfigService(root, configStore)
    return configService.loadSkills(root)
  }

  /**
   * debounce 包装：相同 key 的多次触发合并为一次（DEBOUNCE_MS 后执行）。
   * key 区分全局（GLOBAL_KEY）与各项目 cwd，互不干扰。
   */
  private debounce(key: string, fn: () => Promise<void>): NodeJS.Timeout {
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key)
      void fn()
    }, DEBOUNCE_MS)
    this.debounceTimers.set(key, timer)
    return timer
  }
}
