/**
 * useSubagentView —— subagent 对话流视图管理。
 *
 * 职责：
 * - 管理 Panel sessionId 临时切换（主 session → subagent 虚拟 session → 返回恢复）
 * - 拉取 subagent 列表（session.getSubagents RPC）
 * - 拉取 subagent 对话流历史（session.getSubagentHistory RPC）→ 注入 chatStore
 *
 * 虚拟 session ID 格式：`subagent:<subagentId>`
 * chatStore.messages Map 支持任意 string key，直接用虚拟 session ID 注入消息。
 * 切回主对话流时不清除 subagent 消息缓存（保留缓存，切回时不需要重新加载）。
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
const originalSessionId = ref<string | null>(null)
const currentSubagentId = ref<string | null>(null)
const subagentRecords = ref<SubagentRecord[]>([])

export function useSubagentView() {
  const panel = usePanelStore()
  const chat = useChatStore()

  /** 当前是否在查看 subagent 对话流 */
  const isViewingSubagent = computed(() => viewingSubagent.value)

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
   * 选中 subagent → 切换 Panel 到 subagent 对话流。
   * 1. 保存当前 panel 的原始 sessionId
   * 2. 拉取 subagent 历史 → 注入 chatStore（虚拟 session key）
   * 3. 切换 panel sessionId 为虚拟 session
   *
   * 注意：subagent 的 sessionFile 由 extractor 从主 session JSONL 推导，
   * 后台模式可能存在延迟（bg-notify 未到达前 sessionFile=null，回退查找可能
   * 命中未 flush 完成的文件）。因此每次进入都重新拉取——subagent JSONL 可能
   * 在首次拉取后才有内容（pi 延迟写入策略）。
   */
  async function selectSubagent(subagentId: string): Promise<void> {
    const activePanelId = panel.activePanelId
    const activeLeaf = panel.panels.find((p) => p.id === activePanelId)
    if (!activeLeaf) return

    // 保存原始 sessionId（仅首次进入时保存，避免嵌套覆盖）
    if (!viewingSubagent.value) {
      originalSessionId.value = activeLeaf.sessionId
    }

    currentSubagentId.value = subagentId
    const virtualId = subagentVirtualId(subagentId)

    // 每次进入都重新拉取 subagent 历史（不缓存）。
    // subagent JSONL 可能延迟写入（pi 延迟 flush），首次拉取时可能为空，
    // 后续重入时文件已有内容。chat.setMessages 直接覆盖（不受 hydrated 不可变约束）。
    if (originalSessionId.value) {
      try {
        const history = await sessionApi.getSubagentHistory(originalSessionId.value, subagentId)
        chat.setMessages(virtualId, history)
      } catch (e) {
        console.error('[useSubagentView] getSubagentHistory failed:', e)
        chat.setMessages(virtualId, [])
      }
    }

    // 切换 panel sessionId
    panel.loadSession(activePanelId, virtualId)
    viewingSubagent.value = true
  }

  /**
   * 返回主会话。
   * 恢复 panel sessionId 为原始值，保留 subagent 消息缓存。
   */
  function backToMainSession(): void {
    const activePanelId = panel.activePanelId
    if (originalSessionId.value !== null) {
      panel.loadSession(activePanelId, originalSessionId.value)
    }
    viewingSubagent.value = false
    currentSubagentId.value = null
    originalSessionId.value = null
  }

  /** 清空 subagent 列表（session 切换时） */
  function clearSubagents(): void {
    subagentRecords.value = []
    if (viewingSubagent.value) {
      backToMainSession()
    }
  }

  return {
    isViewingSubagent,
    isCurrentSubagentRunning,
    currentSubagent,
    subagentRecords,
    loadSubagents,
    selectSubagent,
    backToMainSession,
    clearSubagents,
  }
}
