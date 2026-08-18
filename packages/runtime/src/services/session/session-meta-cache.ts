/**
 * SessionMetaCache — 集中式 session 元数据缓存。
 *
 * 解决问题：pi extension auto-rename (pi.setSessionName()) 更新 pi 内部状态并发送
 * session_info_changed 事件，event-adapter 翻译为 session.renamed WS 消息 → 前端
 * 正确更新 label。但 runtime 内存中的 session.label 从未更新，导致后续
 * broadcastSessionList() 时 toSummary() 读到旧 label 覆盖前端正确值。
 *
 * 设计目标：
 * 1. 集中持有所有 session 元数据 (label, thinkingLevel 等) 在单一 Map
 * 2. 提供统一读写 API
 * 3. 订阅 pi 事件自动同步 (事件驱动缓存失效)
 * 4. 作为 toSummary() 和 listAll() 的唯一数据源
 *
 * @module session-meta-cache
 */

/**
 * 单个 session 的元数据缓存条目。
 */
interface SessionMetaEntry {
  /** session 显示名称 (来自 pi session_info_changed 或手动 rename) */
  label?: string
  /** thinking level (来自 pi thinking_level_changed 事件) */
  thinkingLevel?: string
}

/**
 * 集中式 session 元数据缓存。
 *
 * 所有 session 元数据读写必须通过此模块，禁止直接访问 session 对象字段。
 * 这确保了：
 * - pi 事件驱动的自动同步 (session_info_changed / thinking_level_changed)
 * - 手动 rename 的统一处理
 * - toSummary() 始终读到最新值
 */
export class SessionMetaCache {
  /** sessionId → 元数据条目 */
  private cache = new Map<string, SessionMetaEntry>()

  /**
   * 获取或创建条目（惰性初始化）。
   */
  private getOrCreate(sessionId: string): SessionMetaEntry {
    let entry = this.cache.get(sessionId)
    if (!entry) {
      entry = {}
      this.cache.set(sessionId, entry)
    }
    return entry
  }

  // ── Label 读写 ─────────────────────────────────────────────

  /**
   * 设置 session label。
   *
   * 调用方：
   * - event-interpreter: pi session_info_changed 事件到达时
   * - session-lifecycle: 用户手动 rename 时
   * - session-service: initializeManagedSession 初始 label
   */
  setLabel(sessionId: string, label: string): void {
    const entry = this.getOrCreate(sessionId)
    entry.label = label
  }

  /**
   * 获取 session label。
   *
   * 返回 undefined 表示缓存中无该 session 的 label（应 fallback 到 session 对象原始值）。
   */
  getLabel(sessionId: string): string | undefined {
    return this.cache.get(sessionId)?.label
  }

  // ── ThinkingLevel 读写 ─────────────────────────────────────

  /**
   * 设置 session thinking level。
   *
   * 调用方：
   * - event-interpreter: pi thinking_level_changed 事件到达时
   * - session-service: 切模型后从 get_state 查询回写
   */
  setThinkingLevel(sessionId: string, level: string | undefined): void {
    const entry = this.getOrCreate(sessionId)
    entry.thinkingLevel = level
  }

  /**
   * 获取 session thinking level。
   *
   * 返回 undefined 表示缓存中无该 session 的 thinkingLevel（应 fallback 到 session 对象原始值）。
   */
  getThinkingLevel(sessionId: string): string | undefined {
    return this.cache.get(sessionId)?.thinkingLevel
  }

  // ── 缓存管理 ─────────────────────────────────────────────

  /**
   * 删除 session 的缓存条目。
   *
   * session 被删除时调用，避免缓存无界增长。
   */
  delete(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  /**
   * 检查缓存中是否存在指定 session 的条目。
   */
  has(sessionId: string): boolean {
    return this.cache.has(sessionId)
  }

  /**
   * 清空所有缓存（仅供测试用）。
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 获取缓存中的 session 数量（仅供测试/诊断用）。
   */
  get size(): number {
    return this.cache.size
  }
}

/**
 * 全局单例实例。
 *
 * 所有消费方（session-service、event-interpreter、session-lifecycle）共享此实例，
 * 确保 pi 事件驱动的更新对所有读者立即可见。
 */
export const sessionMetaCache = new SessionMetaCache()
