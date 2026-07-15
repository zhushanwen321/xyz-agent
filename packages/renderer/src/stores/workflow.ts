/**
 * Workflow store —— workflow 列表 + 视图层级（列表/详情）+ agent call Panel overlay。
 *
 * 依赖方向：无（stores 间禁止互相 import）。跨 store 编排（chatStore.setMessages 等）
 * 由调用方通过回调注入，store 内不 import 其他 store。
 *
 * 职责：
 * - 共享 workflow 列表（records）—— Sidebar 管理，所有 panel 只读消费
 * - 视图层级：per-panel 两个正交状态字段
 *   - detailRunIdMap：侧边栏视图 2 选中的 workflow runId（仅影响 Sidebar 渲染）
 *   - agentCallMap：Panel overlay 的 agent call sessionId（仅影响 Panel 渲染）
 *
 * [HISTORICAL] 两个状态字段拆分（2026-07-15）：
 * 旧实现用单个 panelViewingMap: Map<panelId, PanelViewing> 联合类型同时承载两个正交 UI 维度，
 * 导致 (1) selectWorkflow 设 workflow-detail → isViewing() 不区分 kind 返回 true → Panel 误进
 * 子代理态（隐藏输入框+子代理标签）；(2) selectAgentCall 覆盖 workflow-detail → getViewingRunId
 * 返回 null → 侧边栏跳回列表。拆分后两个维度独立，互不干扰。
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

/** selectAgentCall 的 chat 注入回调类型（store 不 import chatStore，铁律） */
export type SetMessagesFn = (virtualId: string, messages: Message[]) => void

export const useWorkflowStore = defineStore('workflow', () => {
  // ── state ──
  /** 共享 workflow 列表（Sidebar 管理，所有 panel 共享） */
  const records = ref<WorkflowRunRecord[]>([])

  /** 加载态（M1：loadWorkflows 在途时 true，组件据此显示 spinner） */
  const isLoading = ref(false)
  /** 加载错误（M1：loadWorkflows 失败时设错误消息，null = 无错误；records 保留旧数据不清空） */
  const loadError = ref<string | null>(null)

  /**
   * per-panel 侧边栏视图 2 选中状态（workflow detail）。
   * key = panelId, value = 该 panel 侧边栏正在查看的 workflow runId。
   * 仅影响 Sidebar 渲染（列表 vs detail），不影响 Panel overlay。
   */
  const detailRunIdMap = ref<Map<string, string>>(new Map())

  /**
   * per-panel agent call overlay 状态（Panel overlay）。
   * key = panelId, value = 该 panel Panel overlay 正在查看的 agent call sessionId。
   * 仅影响 Panel 渲染（overlay 对话流），不影响侧边栏视图。
   */
  const agentCallMap = ref<Map<string, string>>(new Map())

  // ── getters ──
  /** workflow 列表计数 */
  function workflowCount(): number {
    return records.value.length
  }

  /**
   * 本 panel 当前是否在 Panel overlay 态（查看 agent call 对话流）。
   * 只读 agentCallMap——侧边栏视图 2（detailRunIdMap）不触发 Panel overlay。
   */
  function isViewing(panelId: string): boolean {
    return agentCallMap.value.has(panelId)
  }

  /** 本 panel 当前查看的 runId（侧边栏视图 2 详情态），非详情态返回 null */
  function getViewingRunId(panelId: string): string | null {
    return detailRunIdMap.value.get(panelId) ?? null
  }

  /** 本 panel 当前查看的 agent call session ID（Panel overlay 态），非 overlay 态返回 null */
  function getViewingAgentCallId(panelId: string): string | null {
    return agentCallMap.value.get(panelId) ?? null
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

  // ── actions ──
  /**
   * 加载 session 的 workflow 列表（共享状态）。
   * 在 Sidebar 切到 Flows tab 或 session 切换时调用。
   */
  async function loadWorkflows(sessionId: string): Promise<void> {
    if (!sessionId) {
      records.value = []
      loadError.value = null
      return
    }
    isLoading.value = true
    loadError.value = null
    try {
      records.value = await sessionApi.getWorkflows(sessionId)
    } catch (e) {
      // M1：失败不清空 records（保留旧数据），设 loadError 让组件显示重试态
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[workflow-store] loadWorkflows failed:', e)
      loadError.value = msg
    } finally {
      isLoading.value = false
    }
  }

  /** 当前焦点 session ID（subscribeWorkflowPush 回调内重新拉取用） */
  let focusedSessionId = ''

  /** running 信号延迟重试间隔（ms）。workflow-state-link 可能刚写入，首次 RPC 拉取为空。 */
  const RUNNING_RETRY_MS = 500

  /**
   * 订阅 runtime 推送的 session.workflowUpdate 广播。
   * runtime 在 workflow 发起/结束时刻推送增量信号，前端收到后触发 loadWorkflows RPC 拉取完整列表。
   *
   * running 信号特殊处理：workflow tool-call-end 触发 running 信号时，主 session JSONL 的
   * workflow-state-link 可能刚 append 还未 flush（pi 延迟写入时序）。延迟 RUNNING_RETRY_MS 再拉一次兜底。
   *
   * @param sessionId 当前焦点 session ID
   * @returns 取消订阅函数（切会话时调用，取消旧 session 的订阅）
   */
  function subscribeWorkflowPush(sessionId: string): () => void {
    focusedSessionId = sessionId
    return events.on(sessionId, (msg) => {
      if (msg.type !== 'session.workflowUpdate') return
      if (!focusedSessionId) return
      // 增量信号 → 重新拉取完整列表
      void loadWorkflows(focusedSessionId)
      // running 信号延迟重试：workflow-state-link 可能刚写入，首次拉取为空
      const payload = msg.payload as { update?: { status?: string } }
      if (payload.update?.status === 'running') {
        const sid = focusedSessionId
        setTimeout(() => {
          if (focusedSessionId === sid) void loadWorkflows(sid)
        }, RUNNING_RETRY_MS)
      }
    })
  }

  /** 清空 workflow 列表 + 退出所有 panel viewing 状态（两个 Map 都清） */
  function clearWorkflows(): void {
    records.value = []
    detailRunIdMap.value = new Map()
    agentCallMap.value = new Map()
  }

  /**
   * 进入侧边栏视图 2（workflow 详情，sidebar 内展示 phase/agent call）。
   * 只写 detailRunIdMap，不影响 Panel overlay（agentCallMap）。
   */
  function selectWorkflow(panelId: string, runId: string): void {
    const next = new Map(detailRunIdMap.value)
    next.set(panelId, runId)
    detailRunIdMap.value = next
  }

  /**
   * 进入 agent call Panel overlay（切 Panel 显示 agent call 对话流）。
   * 只写 agentCallMap，不影响侧边栏视图 2（detailRunIdMap）——修复选中 agent call 后侧边栏跳回列表。
   * store 不 import chatStore（铁律），setMessages 由调用方注入。
   *
   * Fail-fast：getAgentCallHistory 失败时 throw（不静默 setMessages([])）。
   * 调用方负责 catch + toast + 回滚 viewing（调 backFromAgentCall）。
   * agentCallMap 在 getAgentCallHistory 之前写入——失败时调用方需回滚。
   */
  async function selectAgentCall(
    panelId: string,
    mainSessionId: string,
    agentCallSessionId: string,
    setMessages: SetMessagesFn,
  ): Promise<void> {
    const virtualId = agentCallVirtualId(agentCallSessionId)
    const next = new Map(agentCallMap.value)
    next.set(panelId, agentCallSessionId)
    agentCallMap.value = next
    const history = await sessionApi.getAgentCallHistory(mainSessionId, agentCallSessionId)
    setMessages(virtualId, history)
  }

  /** 视图 2 → 视图 1（从 workflow 详情返回列表）。只清 detailRunIdMap，不影响 Panel overlay。 */
  function backToWorkflowList(panelId: string): void {
    const next = new Map(detailRunIdMap.value)
    next.delete(panelId)
    detailRunIdMap.value = next
  }

  /** Panel overlay → 返回（从 agent call 对话流返回）。只清 agentCallMap，保留 detailRunIdMap（侧边栏保持停在 workflow-detail）。 */
  function backFromAgentCall(panelId: string): void {
    const next = new Map(agentCallMap.value)
    next.delete(panelId)
    agentCallMap.value = next
  }

  return {
    // state
    records,
    isLoading,
    loadError,
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
