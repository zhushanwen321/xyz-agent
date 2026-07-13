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
   * 选中 subagent → 进入 subagent 对话流 overlay。
   *
   * overlay 模式：不修改 panel store 的 sessionId（主 session 保持绑定）。
   * 仅设 viewingSubagent=true + 拉取历史注入 chatStore，Panel.vue 据此渲染 subagent 对话流。
   *
   * 主 session ID 从 panel 的 activeLeaf 读取（overlay 不替换，每次进入都能拿到当前 session）。
   *
   * 注意：subagent 的 sessionFile 由 extractor 从主 session JSONL 推导，
   * 后台模式可能存在延迟（bg-notify 未到达前 sessionFile=null，回退查找可能
   * 命中未 flush 完成的文件）。因此每次进入都重新拉取——subagent JSONL 可能
   * 在首次拉取后才有内容（pi 延迟写入策略）。
   */
  async function selectSubagent(subagentId: string): Promise<void> {
    const activeLeaf = panel.panels.find((p) => p.id === panel.activePanelId)
    if (!activeLeaf?.sessionId) return

    const mainSessionId = activeLeaf.sessionId
    currentSubagentId.value = subagentId
    const virtualId = subagentVirtualId(subagentId)

    // 每次进入都重新拉取 subagent 历史（不缓存）。
    // subagent JSONL 可能延迟写入（pi 延迟 flush），首次拉取时可能为空，
    // 后续重入时文件已有内容。chat.setMessages 直接覆盖（不受 hydrated 不可变约束）。
    try {
      const history = await sessionApi.getSubagentHistory(mainSessionId, subagentId)
      chat.setMessages(virtualId, history)
    } catch (e) {
      console.error('[useSubagentView] getSubagentHistory failed:', e)
      chat.setMessages(virtualId, [])
    }

    viewingSubagent.value = true
  }

  /**
   * 返回主会话。
   * overlay 模式：只需 reset viewingSubagent，panel sessionId 从未被修改。
   */
  function backToMainSession(): void {
    viewingSubagent.value = false
    currentSubagentId.value = null
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
    activeSubagentVirtualId,
    currentSubagent,
    subagentRecords,
    loadSubagents,
    selectSubagent,
    backToMainSession,
    clearSubagents,
  }
}
