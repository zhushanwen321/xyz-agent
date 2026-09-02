/**
 * Facade 暴露给 session/ 子模块（lifecycle / dispatcher / scanner）的内部协议。
 *
 * ISP 化终态（session-service-deepening 设计 D2①/S2）：按逐文件去重调用点实测
 * （grep 'this.svc.'）拆三个窄接口——lifecycle 13 / dispatcher 6 / scanner 2 方法。
 * 跨消费者共享 4 方法（detachSession / getSession / removeSessionEntry 为
 * lifecycle+dispatcher 共用，getActiveSummaries 为 lifecycle+scanner 共用）按消费者
 * 在多个窄接口**重复声明、单一实现**——SessionService implements 三窄接口即编译期
 * 防签名漂移守卫（真 ISP：每个消费者可见面 = 实际消费面）。
 *
 * 原宽接口 21 方法中 4 个不进任何窄接口：applyContextUpdate（声明于 ISessionService，
 * 组合根以具体类接线）、handleTurnUsageSideEffects / handleTurnEndSideEffects
 * （event-interpreter 经组合根回调注入消费，回调类型为内联函数签名，不走本文件接口）、
 * markHandedOff（已迁 ISessionService，handoff-service 绑具体类）。
 *
 * 打断模块级循环：子模块 `import type { I*SessionOps } from './session-internal.js'`，
 * Facade `implements` 这些接口 —— 子模块 → 接口 → Facade 单向，无 import 环。
 * （运行期 Facade 调子模块、子模块经接口回调 Facade 是调用环，非依赖环。）
 *
 * sessions Map 单写者：Facade 唯一持有，子模块只经窄接口拿到元素引用做字段更新，
 * 不直接 new / 持有 Map。
 *
 * 叶子模块：仅 `import type`，不引入项目内运行时依赖。
 */
import type { IPiEngine } from '../ports/pi-engine.js'
import type { SessionSummary } from '@xyz-agent/shared'
import type { SessionOutcome } from '../ports/session.js'
import type { IManagedSessionView, ScannedSession } from './types.js'
import type { PresetResolution } from '../preset-service.js'

/**
 * lifecycle 消费的窄接口（SessionLifecycle.svc，13 方法，调用点实测）。
 *
 * 含跨消费者共享方法（重复声明、单一实现）：detachSession / getSession /
 * removeSessionEntry（dispatcher 共用）、getActiveSummaries（scanner 共用）。
 */
export interface ILifecycleSessionOps {
  /**
   * 初始化 ManagedSession 并写入 sessions Map，返回子模块可见视图。hidden 标记隐藏 session。
   * parentSession/forkEntryId 透传 fork 血缘（FR-2 active 路径回传），存入 session 对象后
   * 经 toSummary 输出到 SessionSummary。
   *
   * modelOverride：新 session 实际启动模型（"provider/modelId" 格式，已含 C-RL-6 优先级解析）。
   * 传入时写入 session.modelId 元数据，让前端 composer chip 正确显示（Staging Mode ADR-0056）；
   * 不传时 fallback configStore.getDefaultModel()。注意 pi 进程的模型在 createSession 时已由
   * pi client options 的 model 字段设定，此参数只补齐 session 元数据层的缺口。
   */
  initializeManagedSession(id: string, client: IPiEngine, cwd: string, label: string, sessionFilePath?: string, hidden?: boolean, parentSession?: string, forkEntryId?: string, modelOverride?: string): Promise<IManagedSessionView>
  /** Detach adapter（按 id 查 Map）。pi 事件订阅经 EventAdapter 唯一持有，detach 即收口。 */
  detachSession(sessionId: string): void
  /** 将 ManagedSession 转为对外 SessionSummary（含 git 信息）。 */
  toSummary(s: IManagedSessionView): SessionSummary
  /** 从 scanPiSessions 结果中按 id 查找持久化 session。 */
  findScannedSession(sessionId: string): ScannedSession | undefined
  /** 收集有效的 skill 路径（pi-provider-store + 存在性过滤）。 */
  getSkillPaths(cwd: string): string[]
  /** 收集有效的 extension 路径（经 ExtensionService）。cwd 用于解析相对的 discovery extension 目录。 */
  getExtensionPaths(cwd?: string): Promise<string[]>
  /** 当前生效的替换系统提示词（委托 ConfigService.getReplaceSystemPrompt）。 */
  getReplaceSystemPrompt(): string | undefined
  /**
   * 按 launch presetId 解析 pi 启动参数（委托 PresetService.resolve）。
   * 返回 undefined 时调用方 fallback 到现有 getExtensionPaths/getSkillPaths。
   * 见 SessionService.getLaunchPresetOptions 实现注释 + pi-launch-presets 设计文档 §8.1。
   */
  getLaunchPresetOptions(presetId: string, cwd: string): Promise<PresetResolution | undefined>
  /**
   * 拉取上下文用量并广播 context.update（restoreSession/forkSession 兜底用）。
   * fire-and-forget 语义：失败不阻塞 session 恢复（前端主动拉是主路径）。
   */
  fetchAndBroadcastContext(sessionId: string): Promise<void>
  /** 只读查 Map，返回 managed session 视图（active 判定 + 字段读改）。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** 从 Map 删除条目（仅删条目，不 detach adapter / 不 destroy 进程）。 */
  removeSessionEntry(sessionId: string): void
  /**
   * S3-W2：session 创建事件通知（lifecycle 全部创建入口的收敛点：create /
   * restoreSession / forkSession 的 return 前调用）。Facade 内部触发
   * onSessionCreated → PluginService session 事件注册表定向投递。
   */
  notifySessionCreated(summary: SessionSummary): void
  /** 当前活跃会话的 summary 列表（已含 git 信息）。 */
  getActiveSummaries(): SessionSummary[]
}

/**
 * dispatcher 消费的窄接口（MessageDispatcher.svc，6 方法，调用点实测）。
 *
 * 含跨消费者共享方法（重复声明、单一实现）：detachSession / getSession /
 * removeSessionEntry（lifecycle 共用）。
 */
export interface IDispatcherSessionOps {
  /** 确保会话活跃，必要时自动 restore。 */
  ensureActive(sessionId: string): Promise<IPiEngine>
  /** 按 RPC client 反查 managed session（更新 lastActiveAt / isGenerating 用）。 */
  getSessionByClient(client: IPiEngine): IManagedSessionView | undefined
  /**
   * 写 session_end 终态 entry（W4，ADR 0042）。3 个终态点复用。
   */
  persistSessionOutcome(sessionId: string, outcome: SessionOutcome, reason?: string): void
  /** 只读查 Map，返回 managed session 视图（active 判定 + 字段读改）。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** 从 Map 删除条目（仅删条目，不 detach adapter / 不 destroy 进程）。 */
  removeSessionEntry(sessionId: string): void
  /** Detach adapter（按 id 查 Map）。pi 事件订阅经 EventAdapter 唯一持有，detach 即收口。 */
  detachSession(sessionId: string): void
}

/**
 * scanner 消费的窄接口（SessionScanner.svc，2 方法，调用点实测）。
 *
 * getActiveSummaries 与 lifecycle 共用（重复声明、单一实现）。
 */
export interface IScannerSessionOps {
  /** 当前活跃会话的 summary 列表（已含 git 信息）。 */
  getActiveSummaries(): SessionSummary[]
  /** 当前活跃会话占用的 session 文件路径集合（去重用）。 */
  getActiveFilePaths(): Set<string>
}
