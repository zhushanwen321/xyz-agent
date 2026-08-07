/**
 * W3 H3：chat store LRU 驱逐模块。
 *
 * 对应 FR-1 + D2/D6/D13 + AC-1/2/8/9。
 *
 * 核心策略：
 * - 切走 session 时触发 evictIfNeeded
 * - 保留最近 K=LRU_MAX_SESSIONS(8) 个 + streaming/pending/compacting 豁免的
 * - panel 绑定 session 由 composable 层（useSidebar.selectSession）在 evictIfNeeded 前
 *   刷新 recency 保护（lru-panel-exempt-fix），不在本模块的 isExempt 内判定——
 *   evictSessionWithVirtual 与 evictIfNeeded 共用 isExempt，若加 panel 检查会让
 *   deleteSession 流程中被删 session（必然还绑定 panel）被 exempt 拦截 → 内存泄漏
 * - 驱逐用 delete key（与 disposeSession 一致，D13）
 * - subagent:xxx 三段式虚拟 key 按主 session 前缀同步驱逐（M7 修复，AC-2）
 * - agentcall:xxx 两段式虚拟 key 不走 LRU 联动（无 mainSid 命名空间），由 workflow store 映射清理（D6）
 * - 驱逐时同步清 hydrated 标记（AC-8：切回重新 hydrate）
 *
 * LRU 时序：用模块级 Map<sessionId, timestamp> 记录访问顺序。
 * touchLru 更新时间戳，evictIfNeeded 按时间戳排序驱逐最久未访问的。
 *
 * streaming 豁免（AC-9/SR5）：复用 store 的 isGenerating/isActive/isCompacting 判定。
 * 驱逐前 double-check streaming 状态（SR8 竞态防护）。
 */

import { deleteMessages } from './chat-mutations'

/**
 * LRU 保留阈值：最近 8 个 session（D6）。
 * 不含 streaming/pending/compacting 豁免的（isExempt 判定）。
 * panel 绑定 session 不在本阈值/豁免集内判定，由 composable 层刷新 recency 保护（见文件头注释）。
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
 *
 * [M7] 仅 subagent 用三段式（含 mainSid 命名空间）可按前缀匹配。
 * agentcall 保持两段式（参数是 agent call 自己 session id，无独立子 id），
 * 无法按主 session 前缀定位，其清理走 workflow store 的 mainSessionId 映射（D6），
 * 不在 LRU 联动清理范围内。
 */
export function isVirtualKeyOf(virtualId: string, mainSid: string): boolean {
  return virtualId.startsWith(`subagent:${mainSid}:`)
}

/**
 * evictIfNeeded 的依赖参数（由 chat store 传入）。
 * 用函数类型而非直接引用 store，避免循环依赖 + 便于测试。
 */
export interface LruEvictDeps {
  /**
   * messages Map 的 value getter（shallowRef<Map>）。
   * [W7] 改 getter 而非快照引用——deleteMessageKey 会 messages.value = next（替换 Map），
   * 若 deps 在构造时快照引用，后续 evict 迭代用的是旧 Map，漏判新写入。
   * getter 每次调用读当前值，消除快照陈旧问题。
   */
  messagesValue: () => Map<string, unknown>
  /** hydrated Set 的 value getter（同 messagesValue 理由） */
  hydratedValue: () => Set<string>
  /** 判断 session 是否在豁免集（streaming/pending/compacting 中）。不含 panel 绑定判定——见文件头注释 */
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
 * 3. 同步驱逐关联的 subagent:sid:xxx 三段式虚拟 key（AC-2，isVirtualKeyOf 仅匹配三段式）
 *
 * SR8 竞态防护：驱逐前对每个候选 double-check isExempt（防止驱逐决策后
 * session 变为 streaming 状态）。
 */
export function evictIfNeeded(deps: LruEvictDeps): void {
  // 收集可驱逐的候选（有 messages + 非 virtual + 非豁免 + 有访问记录）
  // [W7] 经 getter 读当前 messages Map（非构造时快照），防 deleteMessageKey 替换 Map 后迭代旧引用。
  const candidates: Array<{ sid: string; lastAccessed: number }> = []
  for (const sid of deps.messagesValue().keys()) {
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

    // AC-2：同步驱逐关联的 subagent:sid:xxx 三段式虚拟 key（agentcall 两段式无 mainSid 前缀，由 workflow store 映射清理）
    for (const virtualKey of [...deps.messagesValue().keys()]) {
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

  // AC-2：同步驱逐关联的 subagent:sid:xxx 三段式虚拟 key（agentcall 两段式无 mainSid 前缀，由 workflow store 映射清理）
  for (const virtualKey of [...deps.messagesValue().keys()]) {
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
 * 清理指定 session 的 LRU 时序记录（disposeSession 调用，R5 内存泄漏修复）。
 */
export function disposeLruEntry(sessionId: string): void {
  sessionLastAccessed.delete(sessionId)
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
    // [W7] getter 而非快照——deleteMessageKey/deleteHydrated 会替换 .value，
    // getter 保证 deps 消费方始终读到当前 Map/Set（消除快照陈旧引用 bug）。
    messagesValue: () => messages.value,
    hydratedValue: () => hydrated.value,
    isExempt,
    // W14: 走 deleteMessages 不可变写入口（与 commitMessages 对称），收敛所有 messages
    // 写入到 chat-mutations，不再散落 new Map + delete + 赋值。
    // has 检查保留——避免无该 session 时也构造新 Map 触发无谓响应式。
    deleteMessageKey: (sid) => {
      if (messages.value.has(sid)) {
        deleteMessages(messages, sid)
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
