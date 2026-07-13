/**
 * useSubagentView —— subagent 对话流视图管理。
 *
 * 职责：
 * - 管理 subagent 对话流的 overlay 显示（不替换 panel 的主 session 绑定）
 * - 拉取 subagent 列表（session.getSubagents RPC）
 * - 拉取 subagent 对话流历史（session.getSubagentHistory RPC）→ 注入 chatStore
 *
 * 虚拟 session ID 格式：`subagent:<subagentId>`
 * chatStore.messages Map 支持任意 string key，直接用虚拟 session ID 注入消息。
 *
 * overlay 模式：选中 subagent 时不修改 panel store 的 sessionId（主 session 保持高亮、
 * 文件视图仍可见）。Panel.vue 通过 activeSubagentVirtualId 决定渲染主 session 还是
 * subagent 对话流——它是 panel 的子状态，不是替换。
 */

import { ref, computed } from 'vue'
import { usePanelStore } from '@/stores/panel'
import { useChatStore } from '@/stores/chat'
import * as sessionApi from '@/api/domains/session'
import type { SubagentRecord } from '@xyz-agent/shared'

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

// 模块级状态（单实例，跟随 active panel）
const viewingSubagent = ref(false)
const currentSubagentId = ref<string | null>(null)
const subagentRecords = ref<SubagentRecord[]>([])

/**
 * [短期方案] 轮询定时器——选中 running 的 subagent 时启动，定期 re-fetch 历史 + 列表。
 *
 * 根因：subagent JSONL 无 push 通道（runtime 无 file-watch，protocol 无 subagent
 * streaming broadcast）。pi 延迟 flush JSONL，选中后只拉一次 → 对话流静态不更新。
 *
 * TODO(长期方案)：pi extension 改造后，subagent 流式事件走 RPC 推送（与主 session
 * 一致），届时移除本轮询，改为事件驱动 setMessages。
 */
const POLL_INTERVAL_MS = 1500
let pollTimer: ReturnType<typeof setInterval> | null = null

export function useSubagentView() {
  const panel = usePanelStore()
  const chat = useChatStore()

  /** 当前是否在查看 subagent 对话流 */
  const isViewingSubagent = computed(() => viewingSubagent.value)

  /** 当前查看的 subagent 的虚拟 session ID（viewing 时有值，否则 null）。
   *  Panel.vue 用它决定渲染 subagent 对话流还是主 session。 */
  const activeSubagentVirtualId = computed(() =>
    viewingSubagent.value && currentSubagentId.value
      ? subagentVirtualId(currentSubagentId.value)
      : null,
  )

  /** 当前查看的 subagent 记录 */
  const currentSubagent = computed(() =>
    currentSubagentId.value
      ? subagentRecords.value.find((s) => s.subagentId === currentSubagentId.value) ?? null
      : null,
  )

  /** 当前查看的 subagent 是否仍在执行中（status='running'）。
   *  用于驱动对话流 trace 展开（与主 agent streaming 态视觉一致）。 */
  const isCurrentSubagentRunning = computed(() => currentSubagent.value?.status === 'running')

  /**
   * 加载 session 的 subagent 列表。
   * 在 Sidebar 切到 Agents tab 时调用。
   */
  async function loadSubagents(sessionId: string): Promise<void> {
    if (!sessionId) {
      subagentRecords.value = []
      return
    }
    try {
      subagentRecords.value = await sessionApi.getSubagents(sessionId)
    } catch (e) {
      console.error('[useSubagentView] loadSubagents failed:', e)
      subagentRecords.value = []
    }
  }

  /**
   * 拉取单个 subagent 的历史并注入 chatStore。
   * 静默失败只记日志——首次拉取为空时轮询会自动补上。
   */
  async function fetchAndInject(mainSessionId: string, subagentId: string): Promise<void> {
    const virtualId = subagentVirtualId(subagentId)
    try {
      const history = await sessionApi.getSubagentHistory(mainSessionId, subagentId)
      chat.setMessages(virtualId, history)
    } catch (e) {
      console.error('[useSubagentView] getSubagentHistory failed:', e)
      chat.setMessages(virtualId, [])
    }
  }

  /**
   * [短期方案] 启动轮询：仅当 subagent 仍在 running 时才轮询。
   * 每个周期同时刷新历史（对话流可见）和列表（检测 status 变更）。
   * status 变为非 running 后自动停止轮询。
   */
  function startPolling(mainSessionId: string, subagentId: string): void {
    stopPolling()
    pollTimer = setInterval(async () => {
      // 列表（检测 status 变更）和历史（对话流更新）是独立数据源，并行请求。
      // 任一失败时保持上一次值不变——下一个周期重试，无需用户感知。
      const [listRes, histRes] = await Promise.allSettled([
        sessionApi.getSubagents(mainSessionId),
        sessionApi.getSubagentHistory(mainSessionId, subagentId),
      ])
      if (listRes.status === 'fulfilled') {
        subagentRecords.value = listRes.value
      }
      if (histRes.status === 'fulfilled') {
        chat.setMessages(subagentVirtualId(subagentId), histRes.value)
      }
      const stillRunning =
        subagentRecords.value.find((s) => s.subagentId === subagentId)?.status === 'running'
      if (!stillRunning) {
        // status 已变更，停止轮询（历史已在本周期刷新）
        stopPolling()
      }
    }, POLL_INTERVAL_MS)
  }

  /** [短期方案] 停止轮询定时器 */
  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /**
   * 选中 subagent → 进入 subagent 对话流 overlay。
   *
   * overlay 模式：不修改 panel store 的 sessionId（主 session 保持绑定）。
   * 仅设 viewingSubagent=true + 拉取历史注入 chatStore，Panel.vue 据此渲染 subagent 对话流。
   *
   * 主 session ID 从 panel 的 activeLeaf 读取（overlay 不替换，每次进入都能拿到当前 session）。
   *
   * 若 subagent 仍在 running，启动轮询定期刷新历史（subagent JSONL 无 push 通道，
   * 需主动 re-fetch 才能看到新增内容）。status 变为非 running 后自动停止轮询。
   */
  async function selectSubagent(subagentId: string): Promise<void> {
    const activeLeaf = panel.panels.find((p) => p.id === panel.activePanelId)
    if (!activeLeaf?.sessionId) return

    const mainSessionId = activeLeaf.sessionId
    currentSubagentId.value = subagentId

    await fetchAndInject(mainSessionId, subagentId)

    viewingSubagent.value = true

    // running 态启动轮询，直到 status 变更
    if (currentSubagent.value?.status === 'running') {
      startPolling(mainSessionId, subagentId)
    }
  }

  /**
   * 返回主会话。
   * overlay 模式：只需 reset viewingSubagent，panel sessionId 从未被修改。
   * 停止轮询（离开 subagent 视图后不再刷新）。
   */
  function backToMainSession(): void {
    stopPolling()
    viewingSubagent.value = false
    currentSubagentId.value = null
  }

  /** 清空 subagent 列表（session 切换时） */
  function clearSubagents(): void {
    stopPolling()
    subagentRecords.value = []
    if (viewingSubagent.value) {
      backToMainSession()
    }
  }

  return {
    isViewingSubagent,
    isCurrentSubagentRunning,
    activeSubagentVirtualId,
    currentSubagent,
    subagentRecords,
    loadSubagents,
    selectSubagent,
    backToMainSession,
    clearSubagents,
    stopPolling,
  }
}
