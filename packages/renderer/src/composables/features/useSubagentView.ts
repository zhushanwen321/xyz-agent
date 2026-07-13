/**
 * useSubagentView —— subagent 对话流视图管理（per-panel）。
 *
 * 职责：
 * - 管理 subagent 对话流的 overlay 显示（不替换 panel 的主 session 绑定）
 * - 拉取 subagent 列表（session.getSubagents RPC）— 共享状态，Sidebar 管理
 * - 拉取 subagent 对话流历史（session.getSubagentHistory RPC）→ 注入 chatStore
 *
 * 虚拟 session ID 格式：`subagent:<subagentId>`
 * chatStore.messages Map 支持任意 string key，直接用虚拟 session ID 注入消息。
 *
 * overlay 模式：选中 subagent 时不修改 panel store 的 sessionId（主 session 保持高亮、
 * 文件视图仍可见）。Panel.vue 通过 activeSubagentVirtualId 决定渲染主 session 还是
 * subagent 对话流——它是 panel 的子状态，不是替换。
 *
 * per-panel 隔离：viewing 状态（正在看哪个 subagent）按 panelId 分区。split 后
 * A panel 进入 subagent 视图不影响 B panel。subagentRecords（列表数据）是共享的
 * （Sidebar 统一管理，所有 panel 只读消费）。
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

/**
 * 查询指定 subagentId 是否仍在 running（读共享 subagentRecords）。
 * 供 MessageStream 等不持有 panelId 的组件判断 forceWorking——无需实例化 per-panel composable。
 */
export function isSubagentRunning(subagentId: string): boolean {
  return subagentRecords.value.find((s) => s.subagentId === subagentId)?.status === 'running'
}

// 模块级共享状态：subagent 列表（Sidebar 管理，所有 panel 共享）。
const subagentRecords = ref<SubagentRecord[]>([])

/**
 * per-panel viewing 状态。split 后每个 panel 独立管理自己的 subagent overlay——
 * A panel 进入 subagent 视图不影响 B panel。
 * key = panelId, value = 该 panel 当前正在查看的 subagentId（null = 未查看）。
 */
const panelViewingMap = ref<Map<string, string | null>>(new Map())

/**
 * [短期方案] per-panel 轮询定时器。
 *
 * 根因：subagent JSONL 无 push 通道（runtime 无 file-watch，protocol 无 subagent
 * streaming broadcast）。pi 延迟 flush JSONL，选中后只拉一次 → 对话流静态不更新。
 *
 * TODO(长期方案)：pi extension 改造后，subagent 流式事件走 RPC 推送（与主 session
 * 一致），届时移除本轮询，改为事件驱动 setMessages。
 */
const POLL_INTERVAL_MS = 1500
const panelPollTimers = new Map<string, ReturnType<typeof setInterval>>()

/** per-panel：读取当前查看的 subagentId */
function getViewingSubagentId(panelId: string): string | null {
  return panelViewingMap.value.get(panelId) ?? null
}

/** per-panel：设置当前查看的 subagentId（null = 退出 subagent 视图） */
function setViewingSubagentId(panelId: string, subagentId: string | null): void {
  const next = new Map(panelViewingMap.value)
  if (subagentId === null) {
    next.delete(panelId)
  } else {
    next.set(panelId, subagentId)
  }
  panelViewingMap.value = next
}

/**
 * useSubagentView —— subagent 对话流视图管理（per-panel 实例化）。
 *
 * @param panelId 当前 Panel 的 ID。Panel.vue / MessageStream.vue 传自己的 panelId，
 *   split 后各 panel 独立。Sidebar.vue 传 undefined（只用列表管理 + selectSubagent
 *   委托给 active panel）。
 */
export function useSubagentView(panelId?: string) {
  const panel = usePanelStore()
  const chat = useChatStore()

  /** 本 panel 当前是否在查看 subagent 对话流 */
  const isViewingSubagent = computed(() =>
    panelId ? getViewingSubagentId(panelId) !== null : false,
  )

  /** 本 panel 当前查看的 subagentId */
  const currentSubagentId = computed(() =>
    panelId ? getViewingSubagentId(panelId) : null,
  )

  /** 本 panel 当前查看的 subagent 的虚拟 session ID（viewing 时有值，否则 null）。
   *  Panel.vue 用它决定渲染 subagent 对话流还是主 session。 */
  const activeSubagentVirtualId = computed(() => {
    const sid = currentSubagentId.value
    return sid ? subagentVirtualId(sid) : null
  })

  /** 当前查看的 subagent 记录（从共享列表中查找） */
  const currentSubagent = computed(() => {
    const sid = currentSubagentId.value
    return sid
      ? subagentRecords.value.find((s) => s.subagentId === sid) ?? null
      : null
  })

  /** 当前查看的 subagent 是否仍在执行中（status='running'）。
   *  用于驱动对话流 trace 展开（与主 agent streaming 态视觉一致）。 */
  const isCurrentSubagentRunning = computed(() => currentSubagent.value?.status === 'running')

  /**
   * 加载 session 的 subagent 列表（共享状态，Sidebar 管理）。
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

  /** [短期方案] 停止指定 panel 的轮询定时器 */
  function stopPolling(targetPanelId?: string): void {
    const id = targetPanelId ?? panelId
    if (!id) return
    const timer = panelPollTimers.get(id)
    if (timer !== undefined) {
      clearInterval(timer)
      panelPollTimers.delete(id)
    }
  }

  /**
   * [短期方案] 启动轮询：仅当 subagent 仍在 running 时才轮询。
   * 每个周期同时刷新历史（对话流可见）和列表（检测 status 变更）。
   * status 变为非 running 后自动停止轮询。
   */
  function startPolling(targetPanelId: string, mainSessionId: string, subagentId: string): void {
    stopPolling(targetPanelId)
    const timer = setInterval(async () => {
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
        stopPolling(targetPanelId)
      }
    }, POLL_INTERVAL_MS)
    panelPollTimers.set(targetPanelId, timer)
  }

  /**
   * 选中 subagent → 进入 subagent 对话流 overlay。
   *
   * overlay 模式：不修改 panel store 的 sessionId（主 session 保持绑定）。
   * 仅设 per-panel viewing 状态 + 拉取历史注入 chatStore。
   *
   * @param subagentId 要查看的 subagent ID
   * @param targetPanelId 目标 panel ID（默认用 composable 实例化的 panelId；
   *   Sidebar 调用时传 active panel ID）
   */
  async function selectSubagent(subagentId: string, targetPanelId?: string): Promise<void> {
    const pid = targetPanelId ?? panelId
    if (!pid) return
    const targetPanel = panel.panels.find((p) => p.id === pid)
    if (!targetPanel?.sessionId) return

    const mainSessionId = targetPanel.sessionId
    setViewingSubagentId(pid, subagentId)

    await fetchAndInject(mainSessionId, subagentId)

    // running 态启动轮询，直到 status 变更
    const record = subagentRecords.value.find((s) => s.subagentId === subagentId)
    if (record?.status === 'running') {
      startPolling(pid, mainSessionId, subagentId)
    }
  }

  /**
   * 返回主会话（per-panel）。
   * overlay 模式：只需 reset per-panel viewing 状态，panel sessionId 从未被修改。
   * 停止轮询（离开 subagent 视图后不再刷新）。
   */
  function backToMainSession(): void {
    if (!panelId) return
    stopPolling()
    setViewingSubagentId(panelId, null)
  }

  /** 清空 subagent 列表（session 切换时，Sidebar 调用）。
   *  同时退出所有 panel 的 subagent 视图 + 停止所有轮询。 */
  function clearSubagents(): void {
    // 停止所有 panel 的轮询
    for (const pid of panelPollTimers.keys()) {
      stopPolling(pid)
    }
    subagentRecords.value = []
    panelViewingMap.value = new Map()
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
