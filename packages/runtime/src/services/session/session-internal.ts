/**
 * Facade 暴露给 session/ 子模块（lifecycle / dispatcher / scanner）的内部协议。
 *
 * 本文件从 interfaces.ts 迁出（R5 重构），目的：
 * - 把 session 域的内部契约收归 session 目录，避免散落在顶层 interfaces.ts
 * - 打断模块级循环：子模块 `import type { ISessionServiceInternal } from './session-internal.js'`，
 *   Facade `implements` 此接口 —— 子模块 → 接口 → Facade 单向，无 import 环。
 *   （运行期 Facade 调子模块、子模块经接口回调 Facade 是调用环，非依赖环。）
 *
 * sessions Map 单写者：Facade 唯一持有，子模块只经此接口拿到元素引用做字段更新，
 * 不直接 new / 持有 Map。
 *
 * 叶子模块：仅 `import type`，不引入项目内运行时依赖，
 * 因此 interfaces.ts 反向 import 此类型不会形成模块环（session-internal.ts ← interfaces.ts 单向）。
 */
import type { IPiEngine } from '../ports/pi-engine.js'
import type { SessionSummary } from '@xyz-agent/shared'
import type { SessionOutcome } from '../ports/session.js'
import type { IManagedSessionView, ScannedSession } from './types.js'

export interface ISessionServiceInternal {
  // ── lifecycle 使用的共享 helper ──
  /** 初始化 ManagedSession 并写入 sessions Map，返回子模块可见视图。hidden 标记隐藏 session。 */
  initializeManagedSession(id: string, client: IPiEngine, cwd: string, label: string, sessionFilePath?: string, hidden?: boolean): Promise<IManagedSessionView>
  /** Detach adapter（按 id 查 Map）。pi 事件订阅经 EventAdapter 唯一持有，detach 即收口。 */
  detachSession(sessionId: string): void
  /** 将 ManagedSession 转为对外 SessionSummary（含 git 信息）。 */
  toSummary(s: IManagedSessionView): SessionSummary
  /** 从 scanPiSessions 结果中按 id 查找持久化 session。 */
  findScannedSession(sessionId: string): ScannedSession | undefined
  /** 收集有效的 skill 路径（pi-provider-store + 存在性过滤）。 */
  getSkillPaths(cwd: string): string[]
  /** 收集有效的 extension 路径（经 ExtensionService）。 */
  getExtensionPaths(): Promise<string[]>

  // ── dispatcher 使用 ──
  /** 确保会话活跃，必要时自动 restore。 */
  ensureActive(sessionId: string): Promise<IPiEngine>
  /** 按 RPC client 反查 managed session（更新 lastActiveAt / isGenerating 用）。 */
  getSessionByClient(client: IPiEngine): IManagedSessionView | undefined
  /**
   * 回写 inputTokens 缓存 + 写 tokenCount + 算 usagePercent + 广播 context.update。
   * totalTokens（W3）写入 session.tokenCount；compact 后用 estimatedTokensAfter 刷新用量。
   */
  applyContextUpdate(sessionId: string, inputTokens: number, totalTokens?: number): void
  /**
   * turn_end 单 turn 副作用（W3）：tryPersistLabel 主路径——首 turn 即持久化。
   * 经 EventInterpreter.onTurnUsage 回调注入。
   */
  handleTurnUsageSideEffects(sessionId: string): void
  /**
   * agent_end 副作用（W3 + W4）：复位 isGenerating=false + tryPersistLabel 兜底 + session_end 终态写入。
   * 经 EventInterpreter.onTurnFinalize 回调注入。
   * @param stopReason pi agent_end 的 stopReason（W4：决定 outcome=error|done）
   */
  handleTurnEndSideEffects(sessionId: string, stopReason?: string): void
  /**
   * 写 session_end 终态 entry（W4，ADR 0036）。3 个终态点复用。
   */
  persistSessionOutcome(sessionId: string, outcome: SessionOutcome, reason?: string): void
  /**
   * 拉取上下文用量并广播 context.update（restoreSession 兜底用）。
   * fire-and-forget 语义：失败不阻塞 session 恢复（前端主动拉是主路径）。
   */
  fetchAndBroadcastContext(sessionId: string): Promise<void>

  // ── lifecycle 使用（Map 单写者：查/删经 Facade）──
  /** 只读查 Map，返回 managed session 视图（active 判定 + 字段读改）。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** 从 Map 删除条目（仅删条目，不 detach adapter / 不 destroy 进程）。 */
  removeSessionEntry(sessionId: string): void

  // ── scanner 使用 ──
  /** 当前活跃会话的 summary 列表（已含 git 信息）。 */
  getActiveSummaries(): SessionSummary[]
  /** 当前活跃会话占用的 session 文件路径集合（去重用）。 */
  getActiveFilePaths(): Set<string>
}
