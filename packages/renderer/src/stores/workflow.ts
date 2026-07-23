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
import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ComputedRef } from 'vue'
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
  /**
   * 按 sessionId 分区的 workflow 列表（ADR-0036 Map 分区派，同 command.ts / subagent.ts 范式）。
   * 切走不清、切回直接读 Map 分区；deleteSession 经 clearSession(sid) 精确释放。
   */
  const recordsBySession = ref<Map<string, WorkflowRunRecord[]>>(new Map())

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

  /**
   * [W3-3] sid → running 信号延迟重试的 setTimeout id 映射。
   * subscribeWorkflowPush 的 unsub 仅移除 WS 事件监听，不 clearTimeout。切 session 时若有在途
   * setTimeout，500ms 后仍会触发 loadWorkflows(旧sid)，用旧 session 列表覆盖新 session。
   * unsub 时经此 Map clearTimeout 并 delete。
   */
  const workflowReloadTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // [W15] 防御性清理：workflowReloadTimers 是模块级 Map（不在 ref 里），HMR / store dispose
  // 时若不主动 clearTimeout，在途的 running 重试 timer 仍会在 500ms 后触发 loadWorkflows(sid)
  // 操作已废弃的 store。参照 subagent.ts 的 onScopeDispose panelStreamUnsub 模式。
  // mainSessionAgentCalls 由 clearWorkflows / clearAgentCallMapping 显式管理（业务路径触发），
  // 此处不重复清理（避免与 deleteSession 的精确清理冲突）。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      workflowReloadTimers.forEach((t) => clearTimeout(t))
      workflowReloadTimers.clear()
    })
  }

  /**
   * 响应式视图：指定 session 的 workflow 列表（供组件 computed 订阅，对齐 command.ts commandsOf）。
   * 切会话时读不同分区，records 变化自动重算。
   */
  function recordsOf(sessionId: string): ComputedRef<WorkflowRunRecord[]> {
    return computed(() => recordsBySession.value.get(sessionId) ?? [])
  }

  /** 非响应式读：指定 session 的 workflow 列表（不写 Map，无则空数组） */
  function getRecordsBySession(sessionId: string): WorkflowRunRecord[] {
    return recordsBySession.value.get(sessionId) ?? []
  }

  /** 该 session 是否有 workflow 仍在 running 或 paused（供 derivedStatus 计算 hasBackgroundWork） */
  function hasRunningOrPaused(sessionId: string): boolean {
    return getRecordsBySession(sessionId).some((s) => s.status === 'running' || s.status === 'paused')
  }

  /** 写入指定 session 的 workflow 列表（不可变写，确保 Map 响应性触发） */
  function applyRecords(sessionId: string, list: WorkflowRunRecord[]): void {
    recordsBySession.value = new Map(recordsBySession.value).set(sessionId, list)
  }

  /** 清除指定 session 的 workflow 列表分区（deleteSession 调，防泄漏，ADR-0036 AC-8） */
  function clearSession(sessionId: string): void {
    if (!recordsBySession.value.has(sessionId)) return
    const next = new Map(recordsBySession.value)
    next.delete(sessionId)
    recordsBySession.value = next
  }

  // ── getters ──
  /**
   * 响应式视图：指定 session 的 workflow 计数（Sidebar badge 用，读取 recordsOf 分区）。
   * 旧的无参 workflowCount() 已移除（store 拿不到 focusedSessionId，调用方传 sid）。
   */
  function workflowCount(sessionId: string): number {
    return getRecordsBySession(sessionId).length
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

  /** 本 panel 当前查看的 workflow record（视图 2 详情态，从 mainSessionId 分区查） */
  function getCurrentWorkflow(panelId: string, mainSessionId: string): WorkflowRunRecord | null {
    const rid = getViewingRunId(panelId)
    if (!rid) return null
    return getRecordsBySession(mainSessionId).find((w) => w.runId === rid) ?? null
  }

  // ── actions ──
  /**
   * 加载 session 的 workflow 列表（写入该 sid 分区）。
   * 在 Sidebar 切到 Flows tab 或 session 切换时调用。
   */
  async function loadWorkflows(sessionId: string): Promise<void> {
    if (!sessionId) return // 空 sid 不写分区
    isLoading.value = true
    loadError.value = null
    try {
      applyRecords(sessionId, await sessionApi.getWorkflows(sessionId))
    } catch (e) {
      // M1：失败不覆盖现有分区（保留旧数据），设 loadError 让组件显示重试态
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
    const off = events.on(sessionId, (msg) => {
      if (msg.type !== 'session.workflowUpdate') return
      // 增量信号 → 重新拉取完整列表
      void loadWorkflows(sid)
      // running 信号延迟重试：workflow-state-link 可能刚写入，首次拉取为空
      const payload = msg.payload as { update?: { status?: string } }
      if (payload.update?.status === 'running') {
        // W3-3：用模块级 Map 跟踪 timer，去重 + 允许 unsub 时 clearTimeout（防切 session 后旧 timer 触发 loadWorkflows(旧sid)）
        const existing = workflowReloadTimers.get(sid)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          workflowReloadTimers.delete(sid)
          void loadWorkflows(sid)
        }, RUNNING_RETRY_MS)
        workflowReloadTimers.set(sid, timer)
      }
    })
    // unsub：移除 WS 事件监听 + 清在途的 running 重试 timer（防 500ms 后 loadWorkflows(旧sid) 覆盖新 session）
    return () => {
      off()
      const t = workflowReloadTimers.get(sid)
      if (t) {
        clearTimeout(t)
        workflowReloadTimers.delete(sid)
      }
    }
  }

  /** 清空所有 workflow 分区 + 退出所有 panel viewing 状态（两个 Map 都清；全局重置场景用） */
  function clearWorkflows(): void {
    recordsBySession.value = new Map()
    detailRunIdMap.value = new Map()
    agentCallMap.value = new Map()
    // W3-2：清非响应式的 mainSessionAgentCalls（selectAgentCall 写入，useWorkflowListSync 切 session 时调本函数）
    mainSessionAgentCalls.clear()
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
   * [B3] chatEvict 必须传带前缀的 agentCallVirtualId，不能传 raw sessionId：
   * selectAgentCall 写入 messages 用的 key 是 `agentcall:<acsId>`（agentCallVirtualId），
   * chatEvict 的实际实现是 chat.evictVirtualKey(virtualId) → deleteMessageKey(virtualId)，
   * 若传 raw sessionId 会 delete 一个从未存在过的 key（no-op），导致 agentcall 虚拟 session
   * 消息永久残留（内存泄漏）。对称参照 subagent.backToMain 传 chatEvict?.(virtualId)。
   *
   * @param chatEvict chat.evictVirtualKey 注入回调（接收带前缀的 virtualId，清 messages，store 不互 import）
   * @param mainSessionId 主 session ID（清 mainSessionAgentCalls Set 用，调用方可获取）
   */
  function backFromAgentCall(
    panelId: string,
    chatEvict?: (virtualId: string) => void,
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
    // [B3] 必须传 agentCallVirtualId(agentCallSessionId)——与 selectAgentCall 写入时的 key 一致
    if (agentCallSessionId && chatEvict) {
      chatEvict(agentCallVirtualId(agentCallSessionId))
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
    recordsBySession,
    isLoading,
    loadError,
    // getters
    workflowCount,
    isViewing,
    getViewingRunId,
    getViewingAgentCallId,
    getActiveAgentCallVirtualId,
    getCurrentWorkflow,
    // per-session 分区读写（ADR-0036 Map 分区派）
    recordsOf,
    getRecordsBySession,
    hasRunningOrPaused,
    applyRecords,
    clearSession,
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
