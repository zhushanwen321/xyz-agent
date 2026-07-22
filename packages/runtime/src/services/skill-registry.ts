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
import { join, isAbsolute } from 'node:path'
import type { SkillInfo } from '@xyz-agent/shared'
import { expandHome } from '../utils/path-utils.js'

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
    const dirs = this.getGlobalDirs()
    if (dirs.length > 0) {
      this.globalWatcher = watch(dirs, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
      })
      this.globalWatcher.on('all', () => {
        void this.debounce(GLOBAL_KEY, async () => {
          this.globalCache = await this.scanFn('')
          await this.notifyGlobalChange()
        })
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
   */
  async getProjectSkills(cwd: string): Promise<SkillInfo[]> {
    const cached = this.projectCache.get(cwd)
    if (cached) return cached

    const skills = await this.scanFn(cwd)
    this.projectCache.set(cwd, skills)

    // 挂项目 watcher（仅监听该 cwd 目录，变动重扫该分区 + 通知匹配 session）
    const watcher = watch(cwd, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
    })
    watcher.on('all', () => {
      void this.debounce(cwd, async () => {
        this.projectCache.set(cwd, await this.scanFn(cwd))
        await this.notifyProjectChange(cwd)
      })
    })
    this.projectWatchers.set(cwd, watcher)

    return skills
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

  // ── 内部工具 ──────────────────────────────────────────────────

  /**
   * 默认扫描实现：复用 ConfigService.loadSkills（封装优先级合并 / 容器目录遍历 / sources badge 链）。
   *
   * 注意：这里 new 一个真实的 PiConfigStore + ConfigService，**不**用构造期注入的 options.configStore——
   * 因为测试注入的 configStore 是 mock（getPiAgentDir 返回 '/pi' 等假路径），生产路径必须读真实
   * discovery.json + 真实 piAgentDir 才能扫到用户实际安装的 skill（U1 依赖此行为：测试机
   * ~/.xyz-agent/pi/agent/skills 有真实 skill）。动态 import 避免顶层硬依赖（循环依赖防护 + 测试隔离）。
   *
   * projectRoot：全局扫描传空串（loadSkills 对全局目录用绝对路径，不受 projectRoot 影响）；
   * 项目扫描传 cwd（解析 discovery.json 相对路径的基准）。
   */
  private async defaultScanFn(projectRoot: string): Promise<SkillInfo[]> {
    const { ConfigService } = await import('./config-service.js')
    const { PiConfigStore } = await import('../infra/pi/pi-config-store.js')
    const realConfigStore = new PiConfigStore()
    const root = projectRoot || process.cwd()
    const configService = new ConfigService(root, realConfigStore)
    return configService.loadSkills(root)
  }

  /** 计算全局 skill 目录列表（piAgentDir/skills、configDir/skills、discovery 绝对/~ 路径）。 */
  private getGlobalDirs(): string[] {
    const dirs = [
      join(this.options.configStore.getPiAgentDir(), 'skills'),
      join(this.options.configDir, 'skills'),
      ...this.options.configStore
        .getSkillPaths()
        .filter(d => isAbsolute(d) || d.startsWith('~'))
        .map(d => expandHome(d)),
    ]
    return dirs
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
