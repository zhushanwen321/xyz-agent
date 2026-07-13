/**
 * Subagent store —— subagent 列表 + per-panel overlay 视图 + streaming/轮询生命周期。
 *
 * 依赖方向：无（stores 间禁止互相 import）。跨 store 编排（chatStore.setMessages 等）
 * 由调用方通过回调注入，store 内不 import 其他 store。
 *
 * 职责：
 * - 共享 subagent 列表（records）—— Sidebar 管理，所有 panel 只读消费
 * - per-panel viewing 状态（panelViewingMap）—— split 后各 panel 独立
 * - streaming 订阅 + 轮询兜底（panelStreamUnsub / panelPollTimers）—— 非响应式资源表
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

/** 轮询间隔（ms）—— streaming 断流兜底 + 检测 status 变更 */
const POLL_INTERVAL_MS = 3000

/**
 * selectSubagent 的 chat 注入回调类型。
 * store 不 import chatStore（铁律），由调用方注入 setMessages。
 */
export type SetMessagesFn = (virtualId: string, messages: Message[]) => void

export const useSubagentStore = defineStore('subagent', () => {
  // ── state ──
  /** 共享 subagent 列表（Sidebar 管理，所有 panel 共享） */
  const records = ref<SubagentRecord[]>([])

  /**
   * per-panel viewing 状态。split 后每个 panel 独立管理自己的 subagent overlay。
   * key = panelId, value = 该 panel 当前正在查看的 subagentId（null = 未查看）。
   */
  const panelViewingMap = ref<Map<string, string | null>>(new Map())

  // ── 非响应式资源表（参照 chat.ts streamingTimers 模式）──
  /** per-panel streaming 订阅取消函数 */
  const panelStreamUnsub = new Map<string, () => void>()
  /** per-panel 轮询定时器（streaming 兜底） */
  const panelPollTimers = new Map<string, ReturnType<typeof setInterval>>()

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
      return
    }
    try {
      records.value = await sessionApi.getSubagents(sessionId)
    } catch (e) {
      console.error('[subagent-store] loadSubagents failed:', e)
      records.value = []
    }
  }

  /** 清空 subagent 列表 + 退出所有 panel overlay + 停止所有 streaming/轮询 */
  function clearSubagents(): void {
    for (const pid of panelStreamUnsub.keys()) stopStream(pid)
    for (const pid of panelPollTimers.keys()) stopPolling(pid)
    records.value = []
    panelViewingMap.value = new Map()
  }

  /**
   * 拉取单个 subagent 的历史并注入 chatStore（经 setMessages 回调）。
   * 静默失败只记日志——首次拉取为空时轮询会自动补上。
   */
  async function fetchAndInject(
    mainSessionId: string,
    subagentId: string,
    setMessages: SetMessagesFn,
  ): Promise<void> {
    const virtualId = subagentVirtualId(subagentId)
    try {
      const history = await sessionApi.getSubagentHistory(mainSessionId, subagentId)
      setMessages(virtualId, history)
    } catch (e) {
      console.error('[subagent-store] getSubagentHistory failed:', e)
      setMessages(virtualId, [])
    }
  }

  /**
   * streaming delta（累积全文）替换到虚拟 session 的最后一条 assistant 消息。
   * 扩展层 setWidget 传的是 buffer 的 split('\n')，每次都是完整文本，用替换而非追加。
   */
  function applyStreamDelta(
    virtualId: string,
    lines: string[],
    getMessages: (virtualId: string) => Message[],
    setMessages: SetMessagesFn,
  ): void {
    const fullText = lines.join('\n')
    const prev = getMessages(virtualId) ?? []
    let lastAssistantIdx = -1
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i].role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    const next = [...prev]
    if (lastAssistantIdx >= 0 && next[lastAssistantIdx].status === 'streaming') {
      const msg = { ...next[lastAssistantIdx] }
      msg.content = fullText
      if (!msg.contentBlocks?.some((b: { type: string }) => b.type === 'text')) {
        msg.contentBlocks = [...(msg.contentBlocks ?? []), { type: 'text', refId: 'text' }]
      }
      next[lastAssistantIdx] = msg
    } else {
      const msg: Message = {
        id: `sa-${crypto.randomUUID()}`,
        role: 'assistant',
        content: fullText,
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: Date.now(),
      }
      next.push(msg)
    }
    setMessages(virtualId, next)
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

  /** 停止指定 panel 的轮询定时器 */
  function stopPolling(targetPanelId?: string): void {
    if (!targetPanelId) return
    const timer = panelPollTimers.get(targetPanelId)
    if (timer !== undefined) {
      clearInterval(timer)
      panelPollTimers.delete(targetPanelId)
    }
  }

  /**
   * 订阅 subagent.stream_delta WS 帧（路径 A-1，逐字增量 streaming）。
   * lines 非空 → applyStreamDelta；lines === undefined → 终态：停 streaming + 轮询 + 拉完整历史。
   */
  function subscribeStream(
    pid: string,
    mainSessionId: string,
    recordId: string,
    virtualId: string,
    getMessages: (virtualId: string) => Message[],
    setMessages: SetMessagesFn,
  ): void {
    stopStream(pid)
    const unsub = events.on(mainSessionId, (msg) => {
      if (msg.type !== 'subagent.stream_delta') return
      const payload = msg.payload as { recordId?: string; lines?: string[] | undefined }
      if (payload.recordId !== recordId) return

      if (payload.lines === undefined) {
        stopStream(pid)
        stopPolling(pid)
        void fetchAndInject(mainSessionId, recordId, setMessages)
        return
      }
      applyStreamDelta(virtualId, payload.lines, getMessages, setMessages)
    })
    panelStreamUnsub.set(pid, unsub)
  }

  /**
   * 启动轮询：仅当 subagent 仍在 running 时才轮询。
   * 每个周期同时刷新历史（对话流可见）和列表（检测 status 变更）。
   * status 变为非 running 后自动停止轮询。
   */
  function startPolling(
    targetPanelId: string,
    mainSessionId: string,
    subagentId: string,
    setMessages: SetMessagesFn,
  ): void {
    stopPolling(targetPanelId)
    const timer = setInterval(async () => {
      const [listRes, histRes] = await Promise.allSettled([
        sessionApi.getSubagents(mainSessionId),
        sessionApi.getSubagentHistory(mainSessionId, subagentId),
      ])
      if (listRes.status === 'fulfilled') {
        records.value = listRes.value
      }
      if (histRes.status === 'fulfilled') {
        setMessages(subagentVirtualId(subagentId), histRes.value)
      }
      const stillRunning =
        records.value.find((s) => s.subagentId === subagentId)?.status === 'running'
      if (!stillRunning) {
        stopPolling(targetPanelId)
      }
    }, POLL_INTERVAL_MS)
    panelPollTimers.set(targetPanelId, timer)
  }

  /**
   * 选中 subagent → 进入 overlay 视图（per-panel）。
   *
   * @param panelId 目标 panel ID
   * @param mainSessionId 主 session ID（panel 绑定的 session）
   * @param subagentId 要查看的 subagent ID
   * @param getMessages chatStore.getMessages（注入，不 import chatStore）
   * @param setMessages chatStore.setMessages（注入，不 import chatStore）
   */
  async function selectSubagent(
    panelId: string,
    mainSessionId: string,
    subagentId: string,
    getMessages: (virtualId: string) => Message[],
    setMessages: SetMessagesFn,
  ): Promise<void> {
    const virtualId = subagentVirtualId(subagentId)
    setViewingSubagentId(panelId, subagentId)

    await fetchAndInject(mainSessionId, subagentId, setMessages)

    // running 态启动 streaming（主通道）+ 轮询（兜底）
    const record = records.value.find((s) => s.subagentId === subagentId)
    if (record?.status === 'running') {
      subscribeStream(panelId, mainSessionId, subagentId, virtualId, getMessages, setMessages)
      startPolling(panelId, mainSessionId, subagentId, setMessages)
    }
  }

  /**
   * 返回主会话（per-panel）。停止 streaming + 轮询 + 重置 viewing 状态。
   */
  function backToMain(panelId: string): void {
    stopStream(panelId)
    stopPolling(panelId)
    setViewingSubagentId(panelId, null)
  }

  return {
    // state
    records,
    // getters
    isViewing,
    getViewingSubagentId,
    getActiveSubagentVirtualId,
    getCurrentSubagent,
    isRunning,
    // actions
    loadSubagents,
    clearSubagents,
    selectSubagent,
    backToMain,
    stopStream,
    stopPolling,
  }
})
