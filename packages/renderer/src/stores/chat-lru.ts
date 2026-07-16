/**
 * W3 H3：chat store LRU 驱逐模块。
 *
 * 对应 FR-1 + D2/D6/D13 + AC-1/2/8/9。
 *
 * 核心策略：
 * - 切走 session 时触发 evictIfNeeded
 * - 保留最近 K=LRU_MAX_SESSIONS(8) 个 + 当前 panel 绑定的 + streaming 中的
 * - 驱逐用 delete key（与 disposeSession 一致，D13）
 * - subagent:xxx / agentcall:xxx 虚拟 key 同步驱逐（M7 修复，AC-2）
 * - 驱逐时同步清 hydrated 标记（AC-8：切回重新 hydrate）
 *
 * LRU 时序：用模块级 Map<sessionId, timestamp> 记录访问顺序。
 * touchLru 更新时间戳，evictIfNeeded 按时间戳排序驱逐最久未访问的。
 *
 * streaming 豁免（AC-9/SR5）：复用 store 的 isGenerating/isActive/isCompacting 判定。
 * 驱逐前 double-check streaming 状态（SR8 竞态防护）。
 */

/**
 * LRU 保留阈值：最近 8 个 session（D6）。
 * 不含当前 panel 绑定的 + streaming 中的（豁免集）。
 */
export const LRU_MAX_SESSIONS = 8

/**
 * session 访问时序记录（模块级，跨 store 实例共享）。
 * key = sessionId，value = 最后访问时间戳。
 * Map 的插入顺序天然反映首次访问顺序，但 LRU 需要按最后访问排序，
 * 所以用 touchLru 维护时间戳，evictIfNeeded 按时间戳排序。
 */
const sessionLastAccessed = new Map<string, number>()

/**
 * 更新 session 的访问时间戳（LRU recency）。
 * 在 getMessages/hydrate/selectSession 时调用。
 */
export function touchLru(sessionId: string): void {
  sessionLastAccessed.set(sessionId, Date.now())
}

/**
 * 判断 sessionId 是否为虚拟 key（subagent/agentcall 派生）。
 */
export function isVirtualKey(sessionId: string): boolean {
  return sessionId.startsWith('subagent:') || sessionId.startsWith('agentcall:')
}

/**
 * 判断 sessionId 是否为某主 session 的虚拟 key（前缀匹配）。
 * subagent:sid:xxx / agentcall:sid:xxx → 主 session 是 sid
 */
export function isVirtualKeyOf(virtualId: string, mainSid: string): boolean {
  return virtualId.startsWith(`subagent:${mainSid}:`) || virtualId.startsWith(`agentcall:${mainSid}:`)
}

/**
 * evictIfNeeded 的依赖参数（由 chat store 传入）。
 * 用函数类型而非直接引用 store，避免循环依赖 + 便于测试。
 */
export interface LruEvictDeps {
  /** messages Map 的 value（shallowRef<Map>） */
  messagesValue: Map<string, unknown>
  /** hydrated Set 的 value */
  hydratedValue: Set<string>
  /** 判断 session 是否在豁免集（panel 绑定 / streaming 中） */
  isExempt: (sessionId: string) => boolean
  /** 删除 messages key（不可变写，返回新 Map） */
  deleteMessageKey: (sessionId: string) => void
  /** 删除 hydrated 标记 */
  deleteHydrated: (sessionId: string) => void
}

/**
 * 检查并执行 LRU 驱逐。
 *
 * 统计可驱逐的 session（非虚拟 key + 非豁免），如果超过 LRU_MAX_SESSIONS，
 * 按最久未访问顺序驱逐超出的部分。驱逐时：
 * 1. deleteMessageKey（清 messages）
 * 2. deleteHydrated（清 hydrated，AC-8 切回重 hydrate）
 * 3. 同步驱逐关联的 subagent:xxx/agentcall:xxx 虚拟 key（AC-2）
 *
 * SR8 竞态防护：驱逐前对每个候选 double-check isExempt（防止驱逐决策后
 * session 变为 streaming 状态）。
 */
export function evictIfNeeded(deps: LruEvictDeps): void {
  // 收集可驱逐的候选（有 messages + 非 virtual + 非豁免 + 有访问记录）
  const candidates: Array<{ sid: string; lastAccessed: number }> = []
  for (const sid of deps.messagesValue.keys()) {
    if (isVirtualKey(sid)) continue
    if (deps.isExempt(sid)) continue
    const lastAccessed = sessionLastAccessed.get(sid)
    if (lastAccessed === undefined) continue
    candidates.push({ sid, lastAccessed })
  }

  // 不超阈值，无需驱逐
  if (candidates.length <= LRU_MAX_SESSIONS) return

  // 按访问时间升序（最久未访问在前），驱逐超出的
  candidates.sort((a, b) => a.lastAccessed - b.lastAccessed)
  const toEvict = candidates.slice(0, candidates.length - LRU_MAX_SESSIONS)

  for (const { sid } of toEvict) {
    // SR8 竞态防护：驱逐前 double-check 豁免状态
    if (deps.isExempt(sid)) continue

    // 驱逐主 session
    deps.deleteMessageKey(sid)
    deps.deleteHydrated(sid)
    sessionLastAccessed.delete(sid)

    // AC-2：同步驱逐关联的虚拟 key（subagent:sid:xxx / agentcall:sid:xxx）
    for (const virtualKey of [...deps.messagesValue.keys()]) {
      if (isVirtualKeyOf(virtualKey, sid)) {
        deps.deleteMessageKey(virtualKey)
        sessionLastAccessed.delete(virtualKey)
      }
    }
  }
}

/**
 * 显式驱逐单个 session 及其虚拟 key（用户返回主会话 / 手动驱逐）。
 *
 * 与 evictIfNeeded 的区别：evictIfNeeded 是阈值触发，evictSessionWithVirtual
 * 是显式驱逐指定 session（不论是否超阈值）。
 */
export function evictSessionWithVirtual(sessionId: string, deps: LruEvictDeps): void {
  // SR8 竜态防护：streaming 中的不驱逐
  if (deps.isExempt(sessionId)) return

  deps.deleteMessageKey(sessionId)
  deps.deleteHydrated(sessionId)
  sessionLastAccessed.delete(sessionId)

  // AC-2：同步驱逐关联的虚拟 key
  for (const virtualKey of [...deps.messagesValue.keys()]) {
    if (isVirtualKeyOf(virtualKey, sessionId)) {
      deps.deleteMessageKey(virtualKey)
      sessionLastAccessed.delete(virtualKey)
    }
  }
}

/**
 * 测试辅助：重置 LRU 时序记录。
 */
export function _resetLruForTest(): void {
  sessionLastAccessed.clear()
}

/**
 * 构造 LRU 驱逐依赖（W3 H3）。
 * evictIfNeeded / evictSessionWithVirtual 共用此 deps 构造器。
 * 从 chat.ts 移入以控制文件行数。
 */
export function makeLruEvictDeps(
  messages: { value: Map<string, unknown> },
  hydrated: { value: Set<string> },
  isExempt: (sid: string) => boolean,
): LruEvictDeps {
  return {
    messagesValue: messages.value,
    hydratedValue: hydrated.value,
    isExempt,
    deleteMessageKey: (sid) => {
      if (messages.value.has(sid)) {
        const next = new Map(messages.value)
        next.delete(sid)
        messages.value = next
      }
    },
    deleteHydrated: (sid) => {
      if (hydrated.value.has(sid)) {
        const next = new Set(hydrated.value)
        next.delete(sid)
        hydrated.value = next
      }
    },
  }
}
