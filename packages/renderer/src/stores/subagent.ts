/**
 * Subagent store —— subagent 列表 + per-panel overlay 视图 + streaming 生命周期。
 *
 * 依赖方向：无（stores 间禁止互相 import）。跨 store 编排（chatStore.setMessages 等）
 * 由调用方通过回调注入，store 内不 import 其他 store。
 *
 * 职责：
 * - 共享 subagent 列表（records）—— Sidebar 管理，所有 panel 只读消费
 * - per-panel viewing 状态（panelViewingMap）—— split 后各 panel 独立
 * - streaming 订阅（panelStreamUnsub）—— 非响应式资源表
 *
 * 虚拟 session ID 格式：`subagent:<subagentId>`
 * chatStore.messages Map 支持任意 string key，直接用虚拟 session ID 注入消息。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SubagentRecord, Message } from '@xyz-agent/shared'
import { session as sessionApi } from '@/api'
import * as events from '@/api/events'

/** 虚拟 session ID 前缀 */
const SUBAGENT_PREFIX = 'subagent:'

/**
 * Tombstone 集合（FR-3/FR-7）：记录已被 backToMain 清除的虚拟 session ID。
 *
 * subscribeStream 终态分支的 fetchAndInject 是 fire-and-forget Promise，backToMain 后若该
 * Promise 在途，完成后会 setMessages 复活已清 messages。tombstone 让终态回调检查后短路。
 * 生命周期：backToMain 设 true，selectSubagent 重进时 delete（新一轮注入不受旧 tombstone 阻止）。
 */
const clearedVirtualIds = new Set<string>()

/**
 * 构造三段式虚拟 session ID：`subagent:<mainSessionId>:<subagentId>`。
 *
 * 三段式提供主 session 命名空间，chat-lru 的 isVirtualKeyOf 据此按前缀联动清理。
 * INVAR-1.1：任何写入 messages 的 subagent key 必须经此工厂，恰好 2 冒号 3 段非空。
 */
export function subagentVirtualId(mainSessionId: string, subagentId: string): string {
  return `${SUBAGENT_PREFIX}${mainSessionId}:${subagentId}`
}

/**
 * 判断 sessionId 是否为合法 subagent 虚拟 session（三段结构校验）。
 *
 * INVAR-1.4：不只 startsWith，必须校验三段结构（前缀 + 2 冒号 + 各段非空），
 * 排除旧两段式残留（subagent:foo）和误传字符串。职责：结构判定（非归属判定）。
 */
export function isSubagentVirtualId(sessionId: string): boolean {
  if (!sessionId.startsWith(SUBAGENT_PREFIX)) return false
  const rest = sessionId.slice(SUBAGENT_PREFIX.length)
  const sepIdx = rest.indexOf(':')
  if (sepIdx <= 0) return false // 无第二冒号或 mainSid 段空
  return sepIdx < rest.length - 1 // subId 段非空
}

/**
 * 从虚拟 session ID 提取 subagentId（第三段，DR9 保持消费契约不变）。
 * 消费方（MessageStream.vue:160 等）按 subId 契约，改三段式不破坏。
 */
export function extractSubagentId(virtualId: string): string {
  const rest = virtualId.slice(SUBAGENT_PREFIX.length)
  return rest.slice(rest.indexOf(':') + 1)
}

/** 从虚拟 session ID 提取 mainSessionId（第二段，供 evictSessionWithVirtual 前缀清理复用）。 */
export function extractMainSessionId(virtualId: string): string {
  const rest = virtualId.slice(SUBAGENT_PREFIX.length)
  return rest.slice(0, rest.indexOf(':'))
}

/**
 * 清理指定主 session 名下的所有 tombstone（deleteSession 调）。
 *
 * 主 session 删除后，其名下 subagent 的 tombstone 无意义（虚拟 key 已随 evictSessionWithVirtual
 * 前缀清理一并删 messages）。tombstone 是模块级 Set，不随 store 实例销毁，若不显式清则随 session
 * 建删单调增长（B8 内存泄漏）。按 extractMainSessionId 前缀精确匹配删除，不误清其他主 session。
 */
export function clearSubagentTombstones(mainSessionId: string): void {
  for (const id of [...clearedVirtualIds]) {
    if (extractMainSessionId(id) === mainSessionId) {
      clearedVirtualIds.delete(id)
    }
  }
}

/**
 * selectSubagent 的 chat 注入回调类型。
 * store 不 import chatStore（铁律），由调用方（features 层 Sidebar.vue）注入。
 *
 * W4：assistant content mutation 收口进 chat store（applySubagentStreamDelta /
 * finalizeSubagentStream），本 store 经回调委托，不再自己 applyStreamDelta。
 * fetchAndInject 仍用 setMessages（含 IO 的历史拉取留在本 store，chat store 保持纯状态机）。
 */
export type SetMessagesFn = (virtualId: string, messages: Message[]) => void
/** chat.applySubagentStreamDelta 注入回调（W4：streaming delta 收口进 chat store） */
export type ApplyDeltaFn = (virtualId: string, lines: string[]) => void
/** chat.finalizeSubagentStream 注入回调（W4：streaming → complete 收口进 chat store） */
export type FinalizeStreamFn = (virtualId: string) => void
/** chat.evictVirtualKey 注入回调（M7：backToMain 清单个 messages[virtualId]，store 不互 import） */
export type ChatEvictFn = (virtualId: string) => void

export const useSubagentStore = defineStore('subagent', () => {
  // ── state ──
  /** 共享 subagent 列表（Sidebar 管理，所有 panel 共享） */
  const records = ref<SubagentRecord[]>([])

  /** 加载态（M1：loadSubagents 在途时 true） */
  const isLoading = ref(false)
  /** 加载错误（M1：loadSubagents 失败时设错误消息，null = 无错误） */
  const loadError = ref<string | null>(null)

  /**
   * per-panel viewing 状态。split 后每个 panel 独立管理自己的 subagent overlay。
   * key = panelId, value = 该 panel 当前正在查看的 subagentId（null = 未查看）。
   */
  const panelViewingMap = ref<Map<string, string | null>>(new Map())

  // ── 非响应式资源表（参照 chat.ts streamingTimers 模式）──
  /** per-panel streaming 订阅取消函数 */
  const panelStreamUnsub = new Map<string, () => void>()

  // ── getters ──
  /** 本 panel 当前是否在查看 subagent 对话流 */
  function isViewing(panelId: string): boolean {
    return panelViewingMap.value.get(panelId) != null
  }

  /** 本 panel 当前查看的 subagentId */
  function getViewingSubagentId(panelId: string): string | null {
    return panelViewingMap.value.get(panelId) ?? null
  }

  /**
   * 本 panel 当前查看的 subagent 的虚拟 session ID（三段式）。
   * mainSessionId 从承载 panel 的 session 取（FR-6 INVAR-6.1），不由 overlay 状态推断。
   */
  function getActiveSubagentVirtualId(panelId: string, mainSessionId: string | null): string | null {
    if (!mainSessionId) return null // INVAR-6.3 空 panel guard
    const sid = getViewingSubagentId(panelId)
    return sid ? subagentVirtualId(mainSessionId, sid) : null
  }

  /** 本 panel 当前查看的 subagent 记录 */
  function getCurrentSubagent(panelId: string): SubagentRecord | null {
    const sid = getViewingSubagentId(panelId)
    return sid ? records.value.find((s) => s.subagentId === sid) ?? null : null
  }

  /** 指定 subagentId 是否仍在 running（读共享 records） */
  function isRunning(subagentId: string): boolean {
    return records.value.find((s) => s.subagentId === subagentId)?.status === 'running'
  }

  // ── viewing 状态读写（内部）──
  function setViewingSubagentId(panelId: string, subagentId: string | null): void {
    const next = new Map(panelViewingMap.value)
    if (subagentId === null) {
      next.delete(panelId)
    } else {
      next.set(panelId, subagentId)
    }
    panelViewingMap.value = next
  }

  // ── actions ──
  /**
   * 加载 session 的 subagent 列表（共享状态）。
   * 在 Sidebar 切到 Agents tab 或 session 切换时调用。
   */
  async function loadSubagents(sessionId: string): Promise<void> {
    if (!sessionId) {
      records.value = []
      loadError.value = null
      return
    }
    isLoading.value = true
    loadError.value = null
    try {
      records.value = await sessionApi.getSubagents(sessionId)
    } catch (e) {
      // M1：失败不清空 records，设 loadError
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[subagent-store] loadSubagents failed:', e)
      loadError.value = msg
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 订阅 runtime 推送的 session.subagents 广播。
   * runtime 在 subagent 状态变化（发起/终态）时主动推送全量列表，
   * 前端被动消费更新 records（驱动 sidebar badge 计数实时变化）。
   *
   * @param sessionId 当前焦点 session ID
   * @returns 取消订阅函数（切会话时调用，取消旧 session 的订阅）
   */
  function subscribeSubagentPush(sessionId: string): () => void {
    return events.on(sessionId, (msg) => {
      if (msg.type !== 'session.subagents') return
      const payload = msg.payload as { subagents: SubagentRecord[] }
      records.value = payload.subagents
    })
  }

  /** 清空 subagent 列表 + 退出所有 panel overlay + 停止所有 streaming */
  function clearSubagents(): void {
    for (const pid of panelStreamUnsub.keys()) stopStream(pid)
    records.value = []
    panelViewingMap.value = new Map()
  }

  /** 停止指定 panel 的 streaming 订阅 */
  function stopStream(targetPanelId?: string): void {
    if (!targetPanelId) return
    const unsub = panelStreamUnsub.get(targetPanelId)
    if (unsub) {
      unsub()
      panelStreamUnsub.delete(targetPanelId)
    }
  }

  /**
   * 拉取单个 subagent 的历史并注入 chatStore（经 setMessages 回调）。
   *
   * [W2 / M5] fail-fast：失败时 throw（不静默 setMessages([])）。对齐 selectAgentCall 的
   * fail-fast 契约——调用方（onSelectSubagent）负责 catch + toast + backToMain 回滚。
   * 此前静默注入空数组会让用户看到空对话流，无错误态/重试入口。
   */
  async function fetchAndInject(
    mainSessionId: string,
    subagentId: string,
    setMessages: SetMessagesFn,
  ): Promise<void> {
    const virtualId = subagentVirtualId(mainSessionId, subagentId)
    const history = await sessionApi.getSubagentHistory(mainSessionId, subagentId)
    setMessages(virtualId, history)
  }

  /**
   * 订阅 subagent.stream_delta WS 帧（路径 A-1，逐字增量 streaming）。
   *
   * W4：delta / 终态收口均经注入的 chat store 回调（chatApplyDelta / chatFinalizeStream），
   * chat store 成为所有 assistant content mutation 的唯一入口。
   * - lines 非空 → chatApplyDelta（chat.applySubagentStreamDelta）
   * - lines === undefined → 终态：停 streaming + 收口 + 拉完整历史覆盖（fetchAndInject，含 IO）
   */
  function subscribeStream(
    pid: string,
    mainSessionId: string,
    recordId: string,
    virtualId: string,
    chatApplyDelta: ApplyDeltaFn,
    chatFinalizeStream: FinalizeStreamFn,
    setMessages: SetMessagesFn,
  ): void {
    stopStream(pid)
    const unsub = events.on(mainSessionId, (msg) => {
      if (msg.type !== 'subagent.stream_delta') return
      const payload = msg.payload as { recordId?: string; lines?: string[] | undefined }
      if (payload.recordId !== recordId) return

      if (payload.lines === undefined) {
        stopStream(pid)
        // 收口 streaming 实体（chat store sealed 收口），再用权威历史覆盖
        chatFinalizeStream(virtualId)
        // [M7 FR-7] tombstone 防复活：backToMain 后此终态回调若在途（fire-and-forget Promise），
        // fetchAndInject 拉取完成后经 tryInjectIfNotCleared 检查 tombstone，已清则短路不 setMessages。
        void sessionApi.getSubagentHistory(mainSessionId, recordId)
          .then((history) => { tryInjectIfNotCleared(virtualId, history, setMessages) })
          .catch((e) => console.error('[subagent] finalize refetch failed:', e))
        return
      }
      chatApplyDelta(virtualId, payload.lines)
    })
    panelStreamUnsub.set(pid, unsub)
  }

  /**
   * 选中 subagent → 进入 overlay 视图（per-panel）。
   *
   * @param panelId 目标 panel ID
   * @param mainSessionId 主 session ID（panel 绑定的 session）
   * @param subagentId 要查看的 subagent ID
   * @param chatApplyDelta chatStore.applySubagentStreamDelta（注入，W4 streaming delta 收口入口）
   * @param chatFinalizeStream chatStore.finalizeSubagentStream（注入，W4 终态收口入口）
   * @param setMessages chatStore.setMessages（注入，fetchAndInject 用，不 import chatStore）
   */
  async function selectSubagent(
    panelId: string,
    mainSessionId: string,
    subagentId: string,
    chatApplyDelta: ApplyDeltaFn,
    chatFinalizeStream: FinalizeStreamFn,
    setMessages: SetMessagesFn,
  ): Promise<void> {
    const virtualId = subagentVirtualId(mainSessionId, subagentId)
    setViewingSubagentId(panelId, subagentId)
    // INVAR-3.4：重进时清 tombstone，允许新一轮 fetchAndInject 注入
    clearedVirtualIds.delete(virtualId)

    await fetchAndInject(mainSessionId, subagentId, setMessages)

    // running 态启动 streaming（逐字增量，终态自动收口 + 拉完整历史）
    const record = records.value.find((s) => s.subagentId === subagentId)
    if (record?.status === 'running') {
      subscribeStream(panelId, mainSessionId, subagentId, virtualId, chatApplyDelta, chatFinalizeStream, setMessages)
    }
  }

  /**
   * 返回主会话（per-panel）。停止 streaming + 立即清 messages[virtualId] + 设 tombstone。
   *
   * FR-3（立即清+tombstone，用户确认撤销等终态）：流程 stopStream → 设 tombstone → chatEvict 清 messages。
   * 立即清不论 streaming——backToMain 后用户不看 overlay，messages 清了不影响 subagent runtime 运行，
   * 用户重进时 fetchAndInject 重新拉取。幂等（INVAR-3.3）：清不存在 key 无副作用。
   *
   * @param panelId 面板 ID
   * @param mainSessionId 主 session ID（构造三段式 virtualId + chatEvict 参数）
   * @param subagentId subagent ID
   * @param chatEvict chat.evictSessionWithVirtual 注入回调（清 messages[virtualId]）
   */
  function backToMain(
    panelId: string,
    mainSessionId?: string,
    subagentId?: string,
    chatEvict?: ChatEvictFn,
  ): void {
    stopStream(panelId)
    setViewingSubagentId(panelId, null)
    // 立即清 messages[virtualId] + 设 tombstone 防终态 fetchAndInject 复活（FR-3/FR-7）
    // 注意：只删单个虚拟 key（evictVirtualKey），不调 evictSessionWithVirtual（会误删主 session 消息）
    if (mainSessionId && subagentId) {
      const virtualId = subagentVirtualId(mainSessionId, subagentId)
      clearedVirtualIds.add(virtualId)
      chatEvict?.(virtualId)
    }
  }

  /**
   * 尝试注入 messages，若 virtualId 已被 backToMain 清除（tombstone）则短路（FR-7 防复活）。
   * subscribeStream 终态 fetchAndInject 完成后调此方法代替直接 setMessages。
   *
   * @returns true=已注入，false=被 tombstone 短路
   */
  function tryInjectIfNotCleared(virtualId: string, messages: Message[], setMessages: SetMessagesFn): boolean {
    if (clearedVirtualIds.has(virtualId)) return false
    setMessages(virtualId, messages)
    return true
  }

  /**
   * 取消 running subagent（调 RPC + 乐观更新）。
   * 成功后立即将 records 中对应项 status 改为 cancelled（不等 WS 推送，避免 UI 延迟）。
   * RPC 失败时不改 status（乐观更新回滚），error 向上抛由调用方 toast。
   *
   * [W3 / W-S7] 不可变写：此前 `record.status = 'cancelled'` 直接 mutation 数组内对象，
   * 与 store 其余「取出 → 新数组 → set」的不可变风格不一致（且不保证响应式触发）。改为
   * map 替换整个 record；回滚用保存的 prevRecords 整体恢复。
   */
  async function cancelSubagent(sessionId: string, subagentId: string): Promise<void> {
    const prevRecords = records.value
    // 乐观更新（假设成功）：不可变 map 替换目标 record
    records.value = prevRecords.map((s) =>
      s.subagentId === subagentId ? { ...s, status: 'cancelled' as const } : s,
    )
    try {
      await sessionApi.subagentAction(sessionId, 'cancel', subagentId)
    } catch (e) {
      // 回滚乐观更新：整体恢复 prevRecords
      records.value = prevRecords
      throw e
    }
  }

  return {
    // state
    records,
    isLoading,
    loadError,
    // getters
    isViewing,
    getViewingSubagentId,
    getActiveSubagentVirtualId,
    getCurrentSubagent,
    isRunning,
    // actions
    loadSubagents,
    subscribeSubagentPush,
    clearSubagents,
    selectSubagent,
    backToMain,
    cancelSubagent,
    stopStream,
    fetchAndInject,
    tryInjectIfNotCleared,
  }
})
