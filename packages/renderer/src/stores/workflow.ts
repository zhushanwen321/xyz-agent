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
import { session as sessionApi } from '@/api'
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

  /**
   * [M7 D6] mainSessionId → Set<agentCallVirtualId> 映射。
   * agentcall 虚拟 key 是两段式（agentcall:<agentCallSessionId>），不含 mainSid 命名空间，
   * 主 session delete 时无法按前缀定位。此映射让 deleteSession 经它清全部 agentcall virtualId。
   */
  const mainSessionAgentCalls = new Map<string, Set<string>>()

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

  /** running 信号延迟重试间隔（ms）。workflow-state-link 可能刚写入，首次 RPC 拉取为空。 */
  const RUNNING_RETRY_MS = 500

  /**
   * 订阅 runtime 推送的 session.workflowUpdate 广播。
   * runtime 在 workflow 发起/结束时刻推送增量信号，前端收到后触发 loadWorkflows RPC 拉取完整列表。
   *
   * running 信号特殊处理：workflow tool-call-end 触发 running 信号时，主 session JSONL 的
   * workflow-state-link 可能刚 append 还未 flush（pi 延迟写入时序）。延迟 RUNNING_RETRY_MS 再拉一次兜底。
   *
   * [W3 / W-S5] 资源/状态一致性修复：此前 `let focusedSessionId` 是 store 级单例闭包变量，
   * 多次调用 subscribeWorkflowPush（A→B）会互相覆盖——A 的回调 / setTimeout 重试读到的
   * focusedSessionId 已是 B 的值，`if (focusedSessionId === sid)` 守卫误判使 A 的 running 重试被吞。
   * 改为函数内局部 const 捕获 sessionId，每次调用各自独立。
   *
   * @param sessionId 当前焦点 session ID
   * @returns 取消订阅函数（切会话时调用，取消旧 session 的订阅）
   */
  function subscribeWorkflowPush(sessionId: string): () => void {
    const sid = sessionId
    return events.on(sessionId, (msg) => {
      if (msg.type !== 'session.workflowUpdate') return
      // 增量信号 → 重新拉取完整列表
      void loadWorkflows(sid)
      // running 信号延迟重试：workflow-state-link 可能刚写入，首次拉取为空
      const payload = msg.payload as { update?: { status?: string } }
      if (payload.update?.status === 'running') {
        setTimeout(() => {
          void loadWorkflows(sid)
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
    // [M7 D6] 记录 mainSessionId → virtualId 映射，供 deleteSession 精确清理 agentcall
    const set = mainSessionAgentCalls.get(mainSessionId) ?? new Set<string>()
    set.add(virtualId)
    mainSessionAgentCalls.set(mainSessionId, set)
    const history = await sessionApi.getAgentCallHistory(mainSessionId, agentCallSessionId)
    setMessages(virtualId, history)
  }

  /** 视图 2 → 视图 1（从 workflow 详情返回列表）。只清 detailRunIdMap，不影响 Panel overlay。 */
  function backToWorkflowList(panelId: string): void {
    const next = new Map(detailRunIdMap.value)
    next.delete(panelId)
    detailRunIdMap.value = next
  }

  /**
   * Panel overlay → 返回（从 agent call 对话流返回）。
   *
   * [M7 FR-4] 立即清 messages[virtualId]（对称 subagent backToMain，立即清+tombstone）。
   * 保留 detailRunIdMap（侧边栏保持停在 workflow-detail）。
   *
   * [W2] mainSessionAgentCalls 的 Set 清理：backFromAgentCall 此前只清 agentCallMap（panel→sessionId），
   * 不清 mainSessionAgentCalls 的 Set，导致非 deleteSession 路径（Panel 返回 / catch 回滚）下 Set 无界增长。
   * deleteSession 路径经 clearAgentCallMapping 整条 delete 已覆盖，但返回主面板路径漏清。
   * 调用方传 mainSessionId（panel 绑定 session）即可精确删该 virtualId。
   *
   * @param chatEvict chat.evictSessionWithVirtual 注入回调（清 messages，store 不互 import）
   * @param mainSessionId 主 session ID（清 mainSessionAgentCalls Set 用，调用方可获取）
   */
  function backFromAgentCall(
    panelId: string,
    chatEvict?: (agentCallSessionId: string) => void,
    mainSessionId?: string,
  ): void {
    const agentCallSessionId = agentCallMap.value.get(panelId)
    const next = new Map(agentCallMap.value)
    next.delete(panelId)
    agentCallMap.value = next
    // 清 mainSessionAgentCalls 映射（防 Set 无界增长，W2）
    if (agentCallSessionId && mainSessionId) {
      mainSessionAgentCalls.get(mainSessionId)?.delete(agentCallVirtualId(agentCallSessionId))
    }
    // 立即清 messages[agentcallVirtualId]（FR-4，与 subagent backToMain 对称）
    if (agentCallSessionId && chatEvict) {
      chatEvict(agentCallSessionId)
    }
  }

  /**
   * [M7 D6] 查询主 session 名下的全部 agentcall virtualId（deleteSession 调，精确清理不泄漏）。
   * 返回后调用方负责 delete messages[key]。
   */
  function getAgentCallVirtualIdsByMain(mainSessionId: string): string[] {
    return [...(mainSessionAgentCalls.get(mainSessionId) ?? [])]
  }

  /** [M7 D6] deleteSession 后清映射条目（主 session 已删，映射无意义） */
  function clearAgentCallMapping(mainSessionId: string): void {
    mainSessionAgentCalls.delete(mainSessionId)
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
    getAgentCallVirtualIdsByMain,
    clearAgentCallMapping,
  }
})
