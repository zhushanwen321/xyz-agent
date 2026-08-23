/**
 * useSidebar —— sidebar 业务编排（R2 features 层）。
 *
 * 这是「唯一跨 api + stores 的层」（R2 铁律 1）：组合 navigation/session/chat/sidebar
 * 四个 store 与 api.session 域，编排 sidebar 的核心动作。
 *
 * 暴露动作：
 * - selectSession(id)：push 导航栈 + switchSession api + 更新 session.activeId（UC-3）
 * - newSession()：create api + push + select（UC-2）
 * - goOverview()：push view:'overview'（ADR-0023，main 区被 Overview 覆盖）
 * - toggleCollapse()：切换 sidebar.collapsed（折叠态 C）
 *
 * 重构演进（2026-07-02 架构返工 C3）：派生状态（derivedStatus / sessionDigest）原在本 composable，
 * 现抽到 useSessionDerivations 轻量 composable（composables/features/useSessionDerivations.ts）。
 * 派生纯函数 deriveStatus 下沉到 composables/logic/sessionStatus.ts（与 DOT_CLASS 同源 5 态 SSOT）。
 * 本 composable 保留 session CRUD + panel/nav 同步 + hydrate + 命令时序 + 文件树预触发 + initApp
 * （核心粘合价值，deletion test 证明不可删）。
 */
import { computed, onScopeDispose } from 'vue'
import type { SessionGroup, BatchDeleteResult } from '@xyz-agent/shared'
import { chat as chatApi, session as sessionApi, extension as extensionApi } from '@/api'
import * as events from '@/api/events'
import { useChatStore } from '@/stores/chat'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import { useWorkspaceStore } from '@/stores/workspace'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useFileTree } from '@/composables/features/file-tree/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useChat, ensureStreamSubscription } from '@/composables/features/chat/useChat'
import { invalidateStatusCache } from '@/composables/features/chat/useSessionDerivations'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'
import { clearUnread } from '@/composables/useSessionMarkers'
import { registerAppCommands } from '@/composables/features/command/useAppCommands'
import { useForkActions } from '@/composables/features/fork-handoff/useForkActions'
import { useHandoffActions } from '@/composables/features/fork-handoff/useHandoffActions'

// ── session.list server-push 订阅（#7 方案 A；CLAUDE.md 规则 #2 防重复注册）──
// useSidebar 被 6+ 组件实例化（Sidebar/Turn/AppShell/PanelContainer/Workspace/Overview），
// 若每实例各注册一次 onGlobalType，每次广播会触发 N 次相同整表快照应用（事件处理翻倍）。
// 模块级 refCount：首个实例注册，末个实例卸载时取消，中间实例共享同一监听。
let sessionListSubCount = 0
let sessionListUnsub: (() => void) | null = null

function bindSessionListBroadcast(applyListSnapshot: (groups: SessionGroup[]) => void): void {
  sessionListSubCount += 1
  if (sessionListSubCount === 1) {
    sessionListUnsub = events.onGlobalType(
      'config.sessions',
      (msg) => applyListSnapshot(msg.payload.groups),
    )
  }
}

function unbindSessionListBroadcast(): void {
  sessionListSubCount = Math.max(0, sessionListSubCount - 1)
  if (sessionListSubCount === 0 && sessionListUnsub) {
    sessionListUnsub()
    sessionListUnsub = null
  }
}

// ── App 启动编排幂等守卫（#1/#3：连接建立后只触发一次自动 startFlow / 恢复最近 session）──
// 模块级跨 useSidebar 实例共享：App.vue watch connected → onConnected() → initApp()。HMR 重连 / 断线重连时
// state 再次变 connected，appBootstrapped 已 true → 跳过，不重复 startFlow（newTaskInFlight 另有守卫）。
let appBootstrapped = false
// [W8] hasConnectedBefore 区分首次 vs 重连 connected。与 appBootstrapped 同模块级——
// 组件卸载重挂（非模块重载）时保留值，避免新实例误判「首次」导致重连 load 刷新失效。
let hasConnectedBefore = false

/** 测试隔离：重置启动编排守卫（与 resetNewTaskFlow 配合，beforeEach 调）。 */
export function resetAppBootstrap(): void {
  appBootstrapped = false
  hasConnectedBefore = false
}

/**
 * [HISTORICAL] clearBoundPanelOverlays（清 bound panel 上残留的 subagent/agent call overlay
 * viewing 状态 + streaming 订阅泄漏）已随 U7 overlay 移除删除。overlay viewing 状态机
 * （panelViewingMap/agentCallMap + selectSubagent/selectAgentCall/backToMain/backFromAgentCall）
 * 全部移除后，deleteSession 不再需要 overlay 兜底清理。虚拟 key 清理走两条独立路径：
 * - subagent: 三段式 → chatStore.evictSessionWithVirtual（LRU isVirtualKeyOf 前缀清理）
 * - agentcall: 两段式 → workflowStore.getAgentCallVirtualIdsByMain + clearAgentCallMapping
 * 两者均在 cleanupSessionState 内独立调用，不依赖 overlay viewing 状态。
 */

export function useSidebar() {
  const navigation = useNavigationStore()
  const session = useSessionStore()
  const chat = useChatStore()
  const sidebar = useSidebarStore()
  const panel = usePanelStore()
  const workspaceStore = useWorkspaceStore()

  /**
   * 当前焦点 panel 绑定的 session（UI 高亮 SSOT）。
   * 直接读 store.focusedSessionId（v2 split 移除后单 panel，此前 local computed 从 panels.find 派生，冗余）。
   * 与 session.activeId 解耦：activeId 收敛为导航/启动语义，不再驱动 UI 高亮。
   * 空 panel（sessionId=null）→ 返回 null（文件树显空态占位）。
   */
  const focusedSessionId = computed<string | null>(() => panel.focusedSessionId)

  /** 焦点 session 的 summary（FileView label/branch 用）；找不到则 null */
  const focusedSession = computed(
    () => session.list.find((s) => s.id === focusedSessionId.value) ?? null,
  )

  /**
   * session.list server-push 订阅（#7 方案 A）。
   * runtime 在 create/delete/rename 后 broadcastSessionList 推全量分组（server.ts:322），
   * 这里 applySnapshot（整表形态）更新列表——只换列表，不重载历史（history hydrate 仅
   * loadSessions/按需做）。与 newSession/deleteSession/renameSession 的本地乐观更新互补：
   * 乐观更新让 UI 即时响应，广播随后用 runtime 权威分组对齐（同一入口，重复写入幂等）。
   * refCount + onScopeDispose：useSidebar 多实例只注册一次，随组件卸载自动收尾。
   */
  bindSessionListBroadcast((groups) => session.applySnapshot({ groups }))
  onScopeDispose(unbindSessionListBroadcast)

  /**
   * 同步 session 到 panel（sidebar 选 session 与 ⌘[/⌘] 导航共用）。
   * 单 panel 下直接载入唯一 panel（v2 split 移除后无 findPanelBySession 切焦点分支）。
   * 幂等：同 sessionId 重复调用，loadSession 同值不变。
   *
   * 编排点在 features 层而非组件 watch——避免「空态时不渲染→watch 不注册→loadSession 不触发」
   * 的初始化时序死锁（原 PanelContainer watch bug，W05 发现）。
   */
  function syncSessionToPanel(sessionId: string): void {
    panel.loadSession(panel.activePanelId, sessionId)
  }

  /**
   * 选择 session：push 导航栈（view:chat + sessionId）+ switchSession api + 更新 activeId + 载入 panel。
   * 首次进入该 session 时拉取历史注入 chat store（UC-2 切换可见块类型，G2-006）。
   * switchSession 失败（mock id 不存在）抛错，UI 层捕获；不更新 activeId。
   *
   * NewTaskFlow 联动（#3 AC-3.10）：flow 活跃时（landing/overlay）切 session → cancelFlow,
   * 让 flow 退到 cancelled（overlay 自动关 + state 不残留 landing）。
   * landing 态覆盖：initApp/点新建后停在 landing，此时点侧栏历史会话须 cancelFlow,
   * 否则 state 残留 landing → isLandingView 仍 true → composer 被误抑制（new-task 渲染撕裂）。
   *
   * commands/context/subagents 由 ensureStreamSubscription → subscribeSession → stateSnapshot dispatch 提供：
   * selectSession 调 ensureStreamSubscription(sid)（幂等：已注册时跳过），它内部同步注册 events.on
   * handler（消费 message 点 session 前缀事件）+ fire-and-forget subscribeSession（拉 snapshot 回放 +
   * stateSnapshot 回流更新 commandStore/contextStore/subagentStore/workflowStore）。
   * events.on 同步注册先于 subscribeSession 的 async snapshot 回放，保证回放事件到达 handler。
   *
   * [HISTORICAL] 2026-07-29 handoff 回复丢失事故：旧实现只调 subscribeSession（拉 snapshot）但不注册
   * events.on handler，导致 snapshot 回放的事件被 dispatchSession 静默丢弃。handoff 场景中新 session 的
   * pi 回复已进 bus ring buffer，但 selectSession → subscribeSession 拉 snapshot 后 dispatchSession 无
   * handler 消费 → 回复永久丢失，UI 卡"进行中…"。改用 ensureStreamSubscription 统一两步（对齐 fork 路径
   * useForkActions.ts:108 的正确范式）。
   * workflows 经 streamRing 内 session.workflowUpdate 增量信号 → triggerWorkflowReload → loadWorkflows
   * RPC（store 自身方法保留），与 useWorkflowListSync focusedSessionId watch 首拉互补覆盖。
   */
  async function selectSession(id: string): Promise<void> {
    // flow 活跃（landing/overlay）时切 session → cancelled（AC-3.10，避免 overlay 卡死 + landing 残留）
    const flow = useNewTaskFlow()
    if (flow.isActive.value) flow.cancelFlow()

    await sessionApi.switchSession(id)
    session.activeId = id
    // 清除未读标记：用户主动查看该 session，不再显示未读 badge
    clearUnread(id)
    // ensureStreamSubscription：同步注册 events.on handler + fire-and-forget subscribeSession。
    // 内部幂等（streamSubscriptions.has(sid) 守卫，已注册跳过）。失败时 subscribeSession 内部
    // console.warn 消化，不阻塞切会话。
    ensureStreamSubscription(id, chat, session)
    // W3 H3：更新 LRU recency（在 evictIfNeeded 之前，确保当前 session 不被驱逐，R3/R4 修复）
    chat.touchLru(id)
    syncSessionToPanel(id)
    navigation.push({ view: 'chat', sessionId: id })
    // 历史回填：features 层跨 api+stores，是 hydrate 的正确编排点
    // getHistory 失败 → 标记 failedHistory，landing 显重试出口（AC-2.6），不永久卡住
    if (!chat.isHydrated(id)) {
      try {
        const { messages, historyTruncated } = await chatApi.getHistory(id)
        chat.reconcileHistory(id, messages)
        useChat().setHistoryTruncated(id, historyTruncated) // N1: 截断标记供 MessageStream 显隐
        chat.clearHistoryError(id)
      } catch {
        chat.markHistoryFailed(id)
      }
    } else {
      // 已 hydrate：静默刷新（后台 session reconcile，同 useSidebarNew.postLoadSession）
      try {
        const { messages } = await chatApi.getHistory(id)
        chat.reconcileHistory(id, messages)
      } catch (e) {
        // 已 hydrate 刷新失败不阻断切入——旧数据仍在，下次切入重试；warn 留排查痕迹
        console.warn('[useSidebar] background reconcile refresh failed for', id, e)
      }
    }

    // 文件树预加载：切 session 即拉取，使侧栏「文件」tab 计数（fileCount 读 store.getTree）
    // 立即更新——不依赖用户切到文件 tab 才触发 FileView 的 loadTree。loadTree 内部缓存复用
    // （已加载则 rehydrate 直接返回），FileView 挂载时再调会命中缓存，无重复请求。
    // fire-and-forget：失败不阻断切 session（文件树缺失仅致 tab 数字为 0，切到文件 tab 仍可重试）。
    // 文件树不在此 wave 的 bus stateSnapshot 覆盖范围（无对应 state type），保留主动拉取。
    void useFileTree().loadTree(id)

    // [lru-panel-exempt-fix] evictIfNeeded 前刷新 panel 绑定 session 的 LRU recency。
    // panel 绑定 session 是用户当前可见的活跃 session，刷新其 recency 确保不被误驱逐。
    // 不改 isLruExempt（chat.ts:424）：evictSessionWithVirtual 与 evictIfNeeded 共用同一 isExempt，
    // 若加 panel 检查会让 deleteSession 流程中被删 session（必然还绑定 panel）被 exempt 拦截 → 内存泄漏。
    if (panel.currentLeaf.sessionId) chat.touchLru(panel.currentLeaf.sessionId)
    // W3 H3：切 session 后触发 LRU 驱逐（保留最近 8 个 + streaming/pending/compacting 豁免）。
    // panel 绑定 session 由上方 touchLru 刷新保护，非 panel 绑定的最旧 session 按序驱逐。
    chat.evictIfNeeded()
  }

  /**
   * 重试加载历史（landing 重试按钮，#2 AC-2.6）：清失败态 + 重新拉取 hydrate。
   */
  async function retryHistory(sessionId: string): Promise<void> {
    chat.clearHistoryError(sessionId)
    try {
      const { messages, historyTruncated } = await chatApi.getHistory(sessionId)
      chat.hydrate(sessionId, messages)
      useChat().setHistoryTruncated(sessionId, historyTruncated)
    } catch {
      chat.markHistoryFailed(sessionId)
    }
  }

  /**
   * 新建 session（薄封装，#3）：委托 useNewTaskFlow.startFlow 编排状态机 + create(cwd)（常态）/
   * 延迟 create（首次启动 AC-1.7），再 selectSession 载入 panel（startFlow 已负责 appendSession + activeId 同步）。
   * 返回新 session id；首次启动延迟 create 时返回 null（Panel 渲染 landing 空态）。
   *
   * presetCwd：可选，预设落地页 chip 的 cwd（initApp 用最近 session 目录预填，G1.1「沿用目录做新任务」）。
   * 未传→用 workspaceStore.defaultCwd 兑底（最近活跃工作区），避免每次都要重新选目录；
   * store 未加载（initApp 首次启动，load 在 newSession 之后）则空 chip 态，由 initApp 后续 presetCwd 回熍。
   */
  let newTaskInFlight = false
  async function newSession(presetCwd?: string): Promise<string | null> {
    if (newTaskInFlight) return null
    newTaskInFlight = true
    try {
      const flow = useNewTaskFlow()
      // 不传 presetCwd 时用最近活跃工作区兑底（用户手动点「新建任务」/⌘N 场景），
      // 避免每次都要重新点目录选择。initApp 首次启动时 store 尚未 load，defaultCwd 为 undefined，
      // startFlow 收到 undefined 走空 chip 态，随后 initApp 自己 presetCwd 回熍。
      const fallback = presetCwd ?? workspaceStore.defaultCwd
      await flow.startFlow(fallback)
      const created = flow.currentSession.value
      if (!created) {
        // 首次启动延迟 create（AC-1.7）：无 session 可选，进 chat view 让 Panel 渲染 landing 空态
        navigation.push({ view: 'chat' })
        return null
      }
      // startFlow 已 appendSession + activeId=created.id；此处只补 panel 载入 + history hydrate
      await selectSession(created.id)
      return created.id
    } finally {
      newTaskInFlight = false
    }
  }

  /**
   * 重命名 session（API + 乐观更新 store）。
   * 编排点在 features 层：跨 api + store 的唯一合法层。
   * 乐观更新 = applySnapshot 本地入参只带 label；权威确认经 config.sessions 整表广播回流。
   */
  async function renameSession(id: string, label: string): Promise<void> {
    await sessionApi.rename(id, label)
    session.applySnapshot(id, { label })
  }

  /**
   * 单 session 的本地状态清理（panel 解绑 + 跨 store 分区释放）。
   *
   * 从 deleteSession 主体提取（供 deleteFolder 复用）：删 session 后同步清 panel 绑定 +
   * 全部 per-session store 分区 + WS 流式订阅 + 派生状态缓存，防内存泄漏与悬空引用。
   * 与 deleteSession 不同——这里不做 WS 删除（调用方已保证 session 在后端已删），
   * 也不做 wasActive 回退（deleteFolder 统一在循环结束后回退）。
   *
   * @param id 已删 session id（WS 删除已完成）
   */
  function cleanupSessionState(id: string): void {
    // 删除的 session 若绑定到 panel，清空 panel 绑定，避免悬空引用指向已删 session。
    const boundPanel = panel.findPanelBySession(id)
    if (boundPanel) panel.loadSession(boundPanel.id, null)
    // [U7] overlay viewing 状态机已移除，clearBoundPanelOverlays 兜底清理随之删除。
    // 虚拟 key 清理走下面 evictSessionWithVirtual（subagent: 前缀）+ agentcall 映射两条独立路径。
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    const extensionUIStore = useExtensionUIStore()
    session.removeFromList(id)
    // 跨 store 清理（S3）：fileTree + subagent + workflow + chat store + WS 流式订阅 + 派生状态缓存（[P4 s5 w2] tasks 已删）
    useFileTreeStore().clearSession(id)
    // ADR-0049 Map 分区派：释放 subagent/workflow store 的 per-session records 分区（防泄漏，AC-8）
    subagentStore.clearSession(id)
    workflowStore.clearSession(id)
    // [CW session-active-ssot] 释放 extension UI pending 分区（防泄漏，与 subagent/workflow 同范式）
    extensionUIStore.clearSession(id)
    // [M7 FR-5] evictSessionWithVirtual 在 disposeSession 之前：先按 mainSid 前缀扫 subagent 虚拟 key，
    // 再 dispose 主 session（dispose 后主记录已删，evict 无法反查）。D5 时序。
    const chatStoreForEvict = useChatStore()
    chatStoreForEvict.evictSessionWithVirtual(id)
    // [M7 D6] agentcall 两段式无 mainSid 前缀，经 workflow 映射清全部 agentcall virtualId
    for (const acsVirtualId of workflowStore.getAgentCallVirtualIdsByMain(id)) {
      chatStoreForEvict.evictVirtualKey(acsVirtualId)
    }
    workflowStore.clearAgentCallMapping(id)
    useChat().disposeSession(id)
    // W3：清除该 session 的 derivedStatus/sessionDigest 缓存，避免已删 session 的 computed 残留
    invalidateStatusCache(id)
    // ADR-0049 W5：触发所有 useSessionScopedState 实例清理该 sid 的 Map 分区，
    // 防已销毁 session 的 per-session 状态条目在 Map 中积累导致内存泄漏（AC-8）。
    // 与 invalidateStatusCache 并列——两者同构（都是单例 composable 的 per-session Map 分区释放）。
    triggerSessionCleanups(id)
  }

  /**
   * 删除 session（API + 本地状态清理）。
   * 删除当前 active 时回退到列表首项（若无则停留空态）。
   *
   * [W1 / S3] 跨 store 清理由 cleanupSessionState 统一承担（panel 解绑 + 全部 per-session 分区释放）。
   *
   * [W1 / S4] 删 active 后 selectSession(next) 失败兜底：cleanupSessionState 已把 activeId
   * 回退到 list[0]，若随后的 selectSession(next) 因网络抖动 reject，activeId=next 但 panel
   * 空载 → 跨 store 撕裂。失败时 fallback 到 navigation.push({ view: 'chat' }) 空态。
   */
  async function deleteSession(id: string): Promise<void> {
    await sessionApi.remove(id)
    const wasActive = session.activeId === id
    cleanupSessionState(id)
    if (wasActive) {
      const next = session.list[0]
      if (next) {
        try {
          await selectSession(next.id)
        } catch {
          // selectSession 失败（网络抖动）→ fallback 到 chat 空态，避免 activeId=next 但 panel 空载撕裂（S4）
          navigation.push({ view: 'chat' })
        }
      } else {
        navigation.push({ view: 'chat' })
      }
    }
  }

  /**
   * 批量删除指定 cwd（folder）下所有 session。
   *
   * 调 sessionApi.removeByCwd 拿 BatchDeleteResult，对 res.deleted 逐个调
   * cleanupSessionState（复用 deleteSession 提取的清理逻辑）。wasActiveInFolder
   * 在调 WS 前快照，循环结束后统一回退（不依赖 removeFromList 中间态）。
   * 返回 BatchDeleteResult——caller（Sidebar.onDeleteFolder）读 res.failed 决定 toast。
   */
  async function deleteFolder(cwd: string): Promise<BatchDeleteResult> {
    // 用已派生的 session.list（单一真源 groups → list，与下文回退 session.list[0] 同源），
    // 避免再 flatMap 一次重复 groups.flatMap(g => g.sessions)（session.ts:list 已是该派生）。
    const wasActiveInFolder = session.list
      .filter((s) => s.cwd === cwd)
      .some((s) => s.id === session.activeId)
    const res = await sessionApi.removeByCwd(cwd)
    for (const sid of res.deleted) {
      cleanupSessionState(sid)
    }
    if (wasActiveInFolder) {
      const next = session.list[0]
      if (next) {
        try {
          await selectSession(next.id)
        } catch {
          navigation.push({ view: 'chat' })
        }
      } else {
        navigation.push({ view: 'chat' })
      }
    }
    return res
  }

  /** 进入 Overview：push view:'overview'（ADR-0023，sidebar 持久，main 被覆盖） */
  function goOverview(): void {
    navigation.push({ view: 'overview' })
  }

  /**
   * Fork 操作（forkSession / forkSessionAsk / forkFromLastAssistant / enterForkModeFromLastAssistant）。
   * 编排逻辑抽到 useForkActions（参照 useSidebarSubagentActions 范式），注入 focusedSessionId ref，
   * 内部自行获取 chat/session stores + api。fork 逻辑与 session CRUD 正交，独立 composable 职责内聚。
   */
  const {
    forkSession,
    forkSessionAsk,
    forkFromLastAssistant,
    enterForkModeFromLastAssistant,
  } = useForkActions(focusedSessionId)

  /**
   * Handoff 操作（handoff / abortHandoff / handoffFromLastAssistant / enterHandoffModeFromLastAssistant）。
   * 编排逻辑抽到 useHandoffActions（参照 useForkActions 范式），注入 focusedSessionId ref，
   * 内部自行获取 chat store + api。handoff 逻辑与 fork 正交，独立 composable 职责内聚。
   */
  const {
    handoff,
    abortHandoff,
    handoffFromLastAssistant,
    enterHandoffModeFromLastAssistant,
  } = useHandoffActions(focusedSessionId)


  /**
   * 加载 session 列表（W6 去全量预 hydrate）。
   * 铁律 1：api 调用只在此 features 层，组件不直接 import api。
   *
   * sessionApi.list() 返 SessionGroup[]（按 cwd 分组，D7），applySnapshot 整表形态填入分组真源。
 * 不再全量预 hydrate 各 session 历史——侧栏 status 由元数据 status（W5 session_end 终态）
 * + 瞬态（isGenerating per-session 惰性派生 flag（W11 D-3）/ compactingSessions Set）派生，
 * 用户点开 session 时按需 hydrate
   * （selectSession 路径不变）。消除启动时 N 次 getHistory 全量读 JSONL 的卡顿峰值 + 内存膨胀。
   */
  async function loadSessions(): Promise<void> {
    try {
      const groups = await sessionApi.list()
      session.applySnapshot({ groups })
      session.setListLoadError(null)
    } catch (e) {
      // S5：list 失败设 listLoadError，SessionList 据此显示「加载失败，点击重试」
      const msg = e instanceof Error ? e.message : String(e)
      session.setListLoadError(msg)
    }
  }

  /**
   * 应用启动编排（#1/#3 启动钩子，连接建立后由 App.vue 触发）：**永远进入新建任务落地页**。
   *
   * 设计裁决（产品对齐 G1.1 字面意）：每次启动都是「新任务」心智——首屏恒为 Landing，
   * 不恢复历史会话对话（恢复整个会话是旧实现，与「沿用目录」的 G1.1 原意不符）。
   * 最近活跃 session 的 cwd 预填到落地页 chip（所见即所得），首发提交据此 create。
   * 历史会话仍在侧栏，随时点回（selectSession 路径不变）。
   *
   * 此前实现：有历史 session 则 selectSession 恢复整个会话（含对话）→ 首屏显示旧对话，
   * 与用户「启动进落地页」预期相反。现统一走 newSession()。
   *
   * 时序关键（修复 idle→dir-popover 崩溃）：**startFlow 必须在 await loadSessions() 之前同步执行**。
   * App.vue watch connectionState==='connected' → `void initApp()`（异步，未 await）→ Vue 同步重渲染
   * 立刻挂载 AppShell/Workspace/Panel/Landing（sessionId===null → isLandingView=true，与 flow.state 无关）。
   * 若先 await loadSessions()（WS 往返 + 全量 history hydrate）再 startFlow，渲染 Landing 与 state 进 landing
   * 之间存在 flow.state=idle 的启动窗口——此窗口内点 directory chip 会触发 idle→dir-popover 非法转换抛错。
   * 故改为：先 newSession()（空 chip 态同步进 landing）→ loadSessions() → presetCwd() 回灌最近 cwd。
   *
   * 幂等：appBootstrapped 守卫只触发一次；失败重置允许下次 connected 重试，不永久卡空态。
   */
  async function initApp(): Promise<void> {
    if (appBootstrapped) return
    appBootstrapped = true
    const flow = useNewTaskFlow()
    try {
      // 0) 注册应用内置命令（新建/收起侧栏/概览）到 commandStore.appCommands。
      //    AC-2.4：启动一次性注册。供搜索浮层（⌘K）命令源聚合 + useSearchJump 跳转执行。
      //    放在 await 之前同步执行，确保 SearchModal 首次打开时 appCommands 已就绪。
      //    actions 注入打破与 useAppCommands 的循环 import（后者不反向 import 本模块）。
      registerAppCommands({
        newSession: () => { void newSession() },
        goOverview,
      })
      // 1) 同步进 landing（空 chip 态）：AppShell 渲染 Landing 时 state 已是 landing → chip 合法可点。
      //    必须先于 await loadSessions()，消除「渲染 Landing 时 state=idle」的启动窗口。
      await newSession()
      // 2) 异步加载侧栏列表（WS 往返 + 全量 history hydrate），不阻塞 landing 渲染。
      await loadSessions()
      // 2b) INV-6: 加载最近工作区记录（workspaceStore.load 必须在 presetCwd 前）。
      await workspaceStore.load()
      // 3) 预填 cwd（G1.1「沿用最近 session 目录」做新任务，chip 所见即所得）。
      //    W3: 数据源改为 session 级——取 sessionStore.list 中 lastActiveAt 最大者的 cwd
      //    （session 的 lastActiveAt 是「上次活跃」真源，比 workspace record 更贴近用户心智）。
      //    无 session 时回退 workspaceStore.defaultCwd（workspace 级兜底）。
      const sessions = session.list
      let recentCwd: string | undefined
      if (sessions.length > 0) {
        // 用 >= 取首个最大（稳定，与 reduce 从左到右 + RecentWorkspacesStore 稳定排序一致）
        const latest = sessions.reduce((a, b) => (a.lastActiveAt >= b.lastActiveAt ? a : b))
        recentCwd = latest.cwd
      }
      if (!recentCwd) recentCwd = workspaceStore.defaultCwd
      if (recentCwd) flow.presetCwd(recentCwd)
    } catch (e) {
      // L1：启动编排失败（list/switch/getHistory reject）→ 重置允许下次 connected 重试
      // 加 console.error 提供最小诊断线索（此前 catch 零可观测性）
      console.error('[initApp] bootstrap failed:', e)
      appBootstrapped = false
    }
  }

  /**
   * [W8] WS 连接建立（含重连）时的统一入口，由 App.vue watch(connectionState) 调用。
   *
   * - 首次 connected（hasConnectedBefore=false）→ initApp（内部含 workspaceStore.load + presetCwd）
   * - 重连 connected（hasConnectedBefore=true）→ initApp 因 appBootstrapped 守卫直接 return，
   *   workspace records 停留在断连前 stale 数据，额外 fire-and-forget workspaceStore.load() 刷新。
   *
   * hasConnectedBefore 与 appBootstrapped 同为模块级，跨 useSidebar 实例共享。
   */
  async function onConnected(): Promise<void> {
    if (!hasConnectedBefore) {
      hasConnectedBefore = true
      await initApp()
      return
    }
    // 重连刷新：runtime 可能重启后从磁盘重载了新记录（如另一窗口写入），stale records 需重拉。
    // fire-and-forget：load 内部 catch 降级（records 置 []），不阻塞、不向上抛。
    void workspaceStore.load()
    // A4 §3.4：extensions 是 sendInitialState 的 async fire-and-forget 段，断连早于
    // 扫描完成则丢失。重连后主动补拉，确保扩展列表新鲜。fire-and-forget 失败不阻断。
    void extensionApi.scan().catch(() => {})
  }

  /** 切换折叠态（C）。展开/折叠 toggle，spec §收起态。 */
  function toggleCollapse(): void {
    sidebar.collapsed = !sidebar.collapsed
  }

  return {
    focusedSessionId,
    focusedSession,
    selectSession,
    newSession,
    retryHistory,
    goOverview,
    loadSessions,
    initApp,
    onConnected,
    toggleCollapse,
    syncSessionToPanel,
    renameSession,
    deleteSession,
    deleteFolder,
    forkSession,
    forkSessionAsk,
    forkFromLastAssistant,
    enterForkModeFromLastAssistant,
    handoff,
    abortHandoff,
    handoffFromLastAssistant,
    enterHandoffModeFromLastAssistant,
  }
}
