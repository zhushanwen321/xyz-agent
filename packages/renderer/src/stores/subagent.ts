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
import * as sessionApi from '@/api/domains/session'
import * as events from '@/api/events'

/** 虚拟 session ID 前缀 */
const SUBAGENT_PREFIX = 'subagent:'

/** 构造虚拟 session ID */
export function subagentVirtualId(subagentId: string): string {
  return `${SUBAGENT_PREFIX}${subagentId}`
}

/** 判断 sessionId 是否为 subagent 虚拟 session */
export function isSubagentVirtualId(sessionId: string): boolean {
  return sessionId.startsWith(SUBAGENT_PREFIX)
}

/** 从虚拟 session ID 提取 subagentId */
export function extractSubagentId(virtualId: string): string {
  return virtualId.slice(SUBAGENT_PREFIX.length)
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

  /** 本 panel 当前查看的 subagent 的虚拟 session ID */
  function getActiveSubagentVirtualId(panelId: string): string | null {
    const sid = getViewingSubagentId(panelId)
    return sid ? subagentVirtualId(sid) : null
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
    const virtualId = subagentVirtualId(subagentId)
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
        void fetchAndInject(mainSessionId, recordId, setMessages)
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
    const virtualId = subagentVirtualId(subagentId)
    setViewingSubagentId(panelId, subagentId)

    await fetchAndInject(mainSessionId, subagentId, setMessages)

    // running 态启动 streaming（逐字增量，终态自动收口 + 拉完整历史）
    const record = records.value.find((s) => s.subagentId === subagentId)
    if (record?.status === 'running') {
      subscribeStream(panelId, mainSessionId, subagentId, virtualId, chatApplyDelta, chatFinalizeStream, setMessages)
    }
  }

  /**
   * 返回主会话（per-panel）。停止 streaming + 重置 viewing 状态。
   */
  function backToMain(panelId: string): void {
    stopStream(panelId)
    setViewingSubagentId(panelId, null)
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
    stopStream,
    fetchAndInject,
  }
})
