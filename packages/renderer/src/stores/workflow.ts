/**
 * Workflow store —— workflow 列表 + 视图层级（列表/详情）+ agent call Panel overlay。
 *
 * 依赖方向：无（stores 间禁止互相 import）。跨 store 编排（chatStore.setMessages 等）
 * 由调用方通过回调注入，store 内不 import 其他 store。
 *
 * 职责：
 * - 共享 workflow 列表（records）—— Sidebar 管理，所有 panel 只读消费
 * - 视图层级：per-panel viewing 状态可为 runId（视图 2 详情）或 agentCallSessionId（Panel overlay）
 *
 * 虚拟 session ID 格式：`agentcall:<sessionId>`（agent call 对话流）
 * chatStore.messages Map 支持任意 string key，直接用虚拟 session ID 注入消息。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WorkflowRunRecord, Message } from '@xyz-agent/shared'
import * as sessionApi from '@/api/domains/session'
import * as events from '@/api/events'

/** 虚拟 session ID 前缀（agent call 对话流） */
const AGENTCALL_PREFIX = 'agentcall:'

/** 构造 agent call 虚拟 session ID */
export function agentCallVirtualId(sessionId: string): string {
  return `${AGENTCALL_PREFIX}${sessionId}`
}

/** 判断 sessionId 是否为 agent call 虚拟 session */
export function isAgentCallVirtualId(sessionId: string): boolean {
  return sessionId.startsWith(AGENTCALL_PREFIX)
}

/** 从虚拟 session ID 提取 agent call 的 pi session ID */
export function extractAgentCallSessionId(virtualId: string): string {
  return virtualId.slice(AGENTCALL_PREFIX.length)
}

/** per-panel viewing 状态联合类型 */
type PanelViewing =
  | { kind: 'workflow-detail'; runId: string }
  | { kind: 'agent-call'; agentCallSessionId: string }
  | null

/** selectAgentCall 的 chat 注入回调类型（store 不 import chatStore，铁律） */
export type SetMessagesFn = (virtualId: string, messages: Message[]) => void

export const useWorkflowStore = defineStore('workflow', () => {
  // ── state ──
  /** 共享 workflow 列表（Sidebar 管理，所有 panel 共享） */
  const records = ref<WorkflowRunRecord[]>([])

  /**
   * per-panel viewing 状态。
   * - workflow-detail：sidebar 内视图 2（workflow 详情，phase/agent call 列表）
   * - agent-call：Panel overlay（agent call 对话流切 Panel）
   * - null：未查看（视图 1 列表态）
   */
  const panelViewingMap = ref<Map<string, PanelViewing>>(new Map())

  // ── getters ──
  /** workflow 列表计数 */
  function workflowCount(): number {
    return records.value.length
  }

  /** 本 panel 当前是否在查看 workflow（详情或 agent call overlay） */
  function isViewing(panelId: string): boolean {
    return panelViewingMap.value.get(panelId) != null
  }

  /** 本 panel 当前查看的 runId（视图 2 详情态），非详情态返回 null */
  function getViewingRunId(panelId: string): string | null {
    const v = panelViewingMap.value.get(panelId)
    return v?.kind === 'workflow-detail' ? v.runId : null
  }

  /** 本 panel 当前查看的 agent call session ID（Panel overlay 态），非 overlay 态返回 null */
  function getViewingAgentCallId(panelId: string): string | null {
    const v = panelViewingMap.value.get(panelId)
    return v?.kind === 'agent-call' ? v.agentCallSessionId : null
  }

  /** 本 panel 当前查看的 agent call 虚拟 session ID（Panel overlay 态） */
  function getActiveAgentCallVirtualId(panelId: string): string | null {
    const sid = getViewingAgentCallId(panelId)
    return sid ? agentCallVirtualId(sid) : null
  }

  /** 本 panel 当前查看的 workflow record（视图 2 详情态） */
  function getCurrentWorkflow(panelId: string): WorkflowRunRecord | null {
    const rid = getViewingRunId(panelId)
    return rid ? records.value.find((w) => w.runId === rid) ?? null : null
  }

  // ── viewing 状态读写（内部）──
  function setViewing(panelId: string, viewing: PanelViewing): void {
    const next = new Map(panelViewingMap.value)
    if (viewing === null) {
      next.delete(panelId)
    } else {
      next.set(panelId, viewing)
    }
    panelViewingMap.value = next
  }

  // ── actions ──
  /**
   * 加载 session 的 workflow 列表（共享状态）。
   * 在 Sidebar 切到 Flows tab 或 session 切换时调用。
   */
  async function loadWorkflows(sessionId: string): Promise<void> {
    if (!sessionId) {
      records.value = []
      return
    }
    try {
      records.value = await sessionApi.getWorkflows(sessionId)
    } catch (e) {
      console.error('[workflow-store] loadWorkflows failed:', e)
      records.value = []
    }
  }

  /** 当前焦点 session ID（subscribeWorkflowPush 回调内重新拉取用） */
  let focusedSessionId = ''

  /**
   * 订阅 runtime 推送的 session.workflowUpdate 广播。
   * runtime 在 workflow 发起/结束时刻推送增量信号，前端收到后触发 loadWorkflows RPC 拉取完整列表。
   *
   * @param sessionId 当前焦点 session ID
   * @returns 取消订阅函数（切会话时调用，取消旧 session 的订阅）
   */
  function subscribeWorkflowPush(sessionId: string): () => void {
    focusedSessionId = sessionId
    return events.on(sessionId, (msg) => {
      if (msg.type !== 'session.workflowUpdate') return
      // 增量信号 → 重新拉取完整列表
      if (focusedSessionId) {
        void loadWorkflows(focusedSessionId)
      }
    })
  }

  /** 清空 workflow 列表 + 退出所有 panel viewing 状态 */
  function clearWorkflows(): void {
    records.value = []
    panelViewingMap.value = new Map()
  }

  /**
   * 进入视图 2（workflow 详情，sidebar 内展示 phase/agent call）。
   */
  function selectWorkflow(panelId: string, runId: string): void {
    setViewing(panelId, { kind: 'workflow-detail', runId })
  }

  /**
   * 进入 agent call Panel overlay（切 Panel 显示 agent call 对话流）。
   * store 不 import chatStore（铁律），setMessages 由调用方注入。
   */
  async function selectAgentCall(
    panelId: string,
    mainSessionId: string,
    agentCallSessionId: string,
    setMessages: SetMessagesFn,
  ): Promise<void> {
    const virtualId = agentCallVirtualId(agentCallSessionId)
    setViewing(panelId, { kind: 'agent-call', agentCallSessionId })
    try {
      const history = await sessionApi.getAgentCallHistory(mainSessionId, agentCallSessionId)
      setMessages(virtualId, history)
    } catch (e) {
      console.error('[workflow-store] getAgentCallHistory failed:', e)
      setMessages(virtualId, [])
    }
  }

  /** 视图 2 → 视图 1（从 workflow 详情返回列表） */
  function backToWorkflowList(panelId: string): void {
    setViewing(panelId, null)
  }

  /** Panel overlay → 返回（从 agent call 对话流返回，回视图 2 或视图 1） */
  function backFromAgentCall(panelId: string): void {
    setViewing(panelId, null)
  }

  return {
    // state
    records,
    // getters
    workflowCount,
    isViewing,
    getViewingRunId,
    getViewingAgentCallId,
    getActiveAgentCallVirtualId,
    getCurrentWorkflow,
    // actions
    loadWorkflows,
    subscribeWorkflowPush,
    clearWorkflows,
    selectWorkflow,
    selectAgentCall,
    backToWorkflowList,
    backFromAgentCall,
  }
})
