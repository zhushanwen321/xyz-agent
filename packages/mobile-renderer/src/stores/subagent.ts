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
import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ComputedRef } from 'vue'
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
  /**
   * 按 sessionId 分区的 subagent 列表（ADR-0036 Map 分区派，同 command.ts 范式）。
   * 切走不清、切回直接读 Map 分区；deleteSession 经 clearSession(sid) 精确释放。
   */
  const recordsBySession = ref<Map<string, SubagentRecord[]>>(new Map())

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

  // 防御性清理：正常由 Panel.vue onUnmounted→stopStream 清理，
  // 此处防止非 Panel 组件调 subscribeStream 后未清。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      for (const unsub of panelStreamUnsub.values()) {
        try {
          unsub()
        // eslint-disable-next-line taste/no-silent-catch -- 作用域销毁兜底清理：unsub 失败不应阻断其余清理，仅记录便于诊断
        } catch (e) {
          console.warn('[subagent-store] panel stream unsub on scope dispose failed:', e)
        }
      }
      panelStreamUnsub.clear()
    })
  }

  /**
   * 响应式视图：指定 session 的 subagent 列表（供组件 computed 订阅，对齐 command.ts commandsOf）。
   * 切会话时读不同分区，records 变化自动重算。
   */
  function recordsOf(sessionId: string): ComputedRef<SubagentRecord[]> {
    return computed(() => recordsBySession.value.get(sessionId) ?? [])
  }

  /** 非响应式读：指定 session 的 subagent 列表（不写 Map，无则空数组，对齐 command.ts getCommands） */
  function getRecordsBySession(sessionId: string): SubagentRecord[] {
    return recordsBySession.value.get(sessionId) ?? []
  }

  /** 该 session 是否有 subagent 仍在 running（供 derivedStatus 计算 hasBackgroundWork） */
  function hasRunning(sessionId: string): boolean {
    return getRecordsBySession(sessionId).some((s) => s.status === 'running')
  }

  /**
   * 写入指定 session 的 subagent 列表（不可变写，确保 Map 响应性触发）。
   * @param sessionId 分区 key
   * @param list runtime 推送 / RPC 拉取的 subagent 列表
   */
  function applyRecords(sessionId: string, list: SubagentRecord[]): void {
    recordsBySession.value = new Map(recordsBySession.value).set(sessionId, list)
  }

  /** 清除指定 session 的 subagent 列表分区（deleteSession 调，防泄漏，ADR-0036 AC-8） */
  function clearSession(sessionId: string): void {
    if (!recordsBySession.value.has(sessionId)) return
    const next = new Map(recordsBySession.value)
    next.delete(sessionId)
    recordsBySession.value = next
  }

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

  /** 本 panel 当前查看的 subagent 记录（从 mainSessionId 分区查） */
  function getCurrentSubagent(panelId: string, mainSessionId: string): SubagentRecord | null {
    const sid = getViewingSubagentId(panelId)
    if (!sid) return null
    return getRecordsBySession(mainSessionId).find((s) => s.subagentId === sid) ?? null
  }

  /** 指定主 session 名下的 subagent 是否仍在 running（读该 sid 分区，不全扫） */
  function isRunning(mainSessionId: string, subagentId: string): boolean {
    return getRecordsBySession(mainSessionId).find((s) => s.subagentId === subagentId)?.status === 'running'
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
   * 加载 session 的 subagent 列表（写入该 sid 分区）。
   * 在 Sidebar 切到 Agents tab 或 session 切换时调用。
   */
  async function loadSubagents(sessionId: string): Promise<void> {
    if (!sessionId) return // 空 sid 不写分区
    isLoading.value = true
    loadError.value = null
    try {
      applyRecords(sessionId, await sessionApi.getSubagents(sessionId))
    } catch (e) {
      // M1：失败不覆盖现有分区，设 loadError
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
   * 前端被动消费更新该 session 分区（驱动 sidebar badge 计数 + working 态实时变化）。
   *
   * [RK1] payload.sessionId 优先：runtime broadcastSubagents 帧 payload 含 sessionId 字段
   * （event-interpreter.ts:500），用它写对应分区（规则#7 推送链路隔离延伸，非焦点 session 终态推送也写分区）；
   * payload 无 sessionId 回落闭包 sid。
   *
   * @param sessionId 当前焦点 session ID
   * @returns 取消订阅函数（切会话时调用，取消旧 session 的订阅）
   */
  function subscribeSubagentPush(sessionId: string): () => void {
    return events.on(sessionId, (msg) => {
      if (msg.type !== 'session.subagents') return
      const payload = msg.payload as { subagents?: unknown; sessionId?: string }
      // 运行时守卫：runtime 契约稳定但仍校验，避免字段漂移时静默覆盖。
      if (Array.isArray(payload.subagents)) {
        applyRecords(payload.sessionId ?? sessionId, payload.subagents as SubagentRecord[])
      }
    })
  }

  /** 清空所有 subagent 分区 + 退出所有 panel overlay + 停止所有 streaming（全局重置场景用） */
  function clearSubagents(): void {
    for (const pid of panelStreamUnsub.keys()) stopStream(pid)
    recordsBySession.value = new Map()
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
    const record = getRecordsBySession(mainSessionId).find((s) => s.subagentId === subagentId)
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
   * 取消 running subagent（调 RPC + 乐观更新该 sid 分区）。
   * 成功后立即将分区中对应项 status 改为 cancelled（不等 WS 推送，避免 UI 延迟）。
   * RPC 失败时不改 status（乐观更新回滚），error 向上抛由调用方 toast。
   */
  async function cancelSubagent(sessionId: string, subagentId: string): Promise<void> {
    const prevRecords = getRecordsBySession(sessionId)
    // 乐观更新（假设成功）：不可变 map 替换目标 record
    applyRecords(
      sessionId,
      prevRecords.map((s) =>
        s.subagentId === subagentId ? { ...s, status: 'cancelled' as const } : s,
      ),
    )
    try {
      await sessionApi.subagentAction(sessionId, 'cancel', subagentId)
    } catch (e) {
      // 回滚乐观更新：整体恢复 prevRecords
      applyRecords(sessionId, prevRecords)
      throw e
    }
  }

  return {
    // state
    recordsBySession,
    isLoading,
    loadError,
    // getters
    isViewing,
    getViewingSubagentId,
    getActiveSubagentVirtualId,
    getCurrentSubagent,
    isRunning,
    // per-session 分区读写（ADR-0036 Map 分区派）
    recordsOf,
    getRecordsBySession,
    hasRunning,
    applyRecords,
    clearSession,
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
