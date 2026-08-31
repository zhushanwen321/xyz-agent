/**
 * useSidebar —— sidebar 业务编排（R2 features 层，session-sidebar 域 P3 绞杀终态）。
 *
 * 这是「唯一跨 api + stores 的层」（R2 铁律 1）：包装 core createUseSession（w3）+ 注入
 * 端口适配（SessionApiPort/PanelOrchestrationPort/NavigationPort/ChatHydratePort/
 * SessionCleanupHooks/NewTaskFlowPort + selectSessionFallback 回退端口）+ renderer 专属编排。
 * 2026-08-31 双轨收尾：旧 useSidebar（自持全量编排版）删除，本文件由 useSidebar.ts
 * 重命名接管原名（C-W5-4 消费方切换完成），返回签名与旧版对齐 + 超集（restoreSession/
 * assignSessionToProject）。
 *
 * 关键裁决：
 * - C-W5-1：selectSession/newSession 壳重编排（不代理 core.selectSession）——core.selectSession
 *   是闭合函数，renderer 专属步骤（ensureStreamSubscription 须先于 syncSessionToPanel / LRU /
 *   clearUnread / fileTree 预加载 / flow.cancelFlow）无法插入其内部。core.selectSession 留
 *   headless/mobile 消费。deleteSession/deleteFolder 代理 core，wasActive 回退经
 *   selectSessionFallback 端口走本壳版 selectSession（C-W5-1 债务已清偿）；空态承接 [D7]
 *   由 core enterEmptyChatState 经 flow 端口完成。
 * - C-W5-5（ADR-0059 重构）：sessionStore 经 pinia useSessionStore() cast 成 core factory 类型。
 *   core createUseSession 经方法访问 store（getActiveId/setActiveId/getList，ADR-0059 决策 1），
 *   方法闭包持原始 ref，pinia unwrap 不影响方法内部 .value。消除原 raw 双轨 + config.sessions 桥接。
 *
 * 边界（C-W4-3 / FU-1）：thinkingLevel apply / panel.loadSession / navigation.push / send /
 * transition 留 useNewTaskFlow 壳（submitFirstMessage 改调 core createSessionFlow，见该文件）。
 */
import type { ComputedRef } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'
import {
  createSessionStore,
  createUseSession,
  resetSessionListSubForTest,
} from '@xyz-agent/core'
import type {
  SessionApiPort,
  PanelOrchestrationPort,
  ChatHydratePort,
  NavigationPort,
  SessionCleanupHooks,
  NewTaskFlowPort,
} from '@xyz-agent/core'
import { chat as chatApi, session as sessionApi, extension as extensionApi } from '@/api'
import * as events from '@/api/events'
import { useChatStore } from '@/stores/chat'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useWorkspaceStore } from '@/stores/workspace'
import { useFileTree } from '@/composables/features/file-tree/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useChat, ensureStreamSubscription } from '@/composables/features/chat/useChat'
import { invalidateStatusCache } from '@/composables/features/chat/useSessionDerivations'
import { clearUnread } from '@/composables/useSessionMarkers'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import { registerAppCommands } from '@/composables/features/command/useAppCommands'
import { useForkActions } from '@/composables/features/fork-handoff/useForkActions'
import { useHandoffActions } from '@/composables/features/fork-handoff/useHandoffActions'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import type { NavEntry } from '@/types'

// ── App 启动编排幂等守卫 ──
let appBootstrapped = false
let hasConnectedBefore = false

/** 测试隔离：重置启动编排守卫 + session.list 订阅计数（beforeEach 调）。 */
export function resetAppBootstrap(): void {
  appBootstrapped = false
  hasConnectedBefore = false
  resetSessionListSubForTest()
}

/**
 * 构建 SessionApiPort 适配（壳把现 api/domains/session + events 适配注入 core）。
 * core 定义端口接口、壳注入实现（与 PlatformPort 同模式，D4 单一归位）。
 */
function buildSessionApiPort(): SessionApiPort {
  return {
    list: () => sessionApi.list(),
    switchSession: (id) => sessionApi.switchSession(id),
    create: (cwd, label, presetId) => sessionApi.create(cwd, label, presetId),
    rename: (id, label) => sessionApi.rename(id, label),
    remove: (id) => sessionApi.remove(id),
    removeByCwd: (cwd) => sessionApi.removeByCwd(cwd),
    migrateImage: (p) => sessionApi.migrateImage(p),
    onConfigSessions: (handler) =>
      events.onGlobalType('config.sessions', (msg) => handler(msg.payload.groups)),
  }
}

export function useSidebar() {
  const navigation = useNavigationStore()
  const chat = useChatStore()
  const sidebar = useSidebarStore()
  const panel = usePanelStore()
  const workspaceStore = useWorkspaceStore()

  // ── 端口适配层（core 定义接口、壳注入 renderer 实现）──
  const api: SessionApiPort = buildSessionApiPort()

  const panelPort: PanelOrchestrationPort = {
    focusedSessionId: () => panel.focusedSessionId,
    activePanelId: () => panel.activePanelId,
    findPanelBySession: (sid) => panel.findPanelBySession(sid),
    loadSession: (panelId, sid) => panel.loadSession(panelId, sid),
    // [P4 s5 drawer-widget-removal] tasks drawer 分支已删（tasks tab 移除），统一 open sideDrawer
    openPanel: (sid) => {
      const { open } = useSideDrawerSafe()
      open()
      void sid // sideDrawer 内部按 focusedSessionId 路由，sid 透传无运行时消费（core 契约对齐）
    },
  }

  const navigationPort: NavigationPort = {
    push: (route) => {
      const entry: NavEntry = { view: route.view as NavEntry['view'] }
      if (route.sessionId !== undefined && route.sessionId !== null) entry.sessionId = route.sessionId
      navigation.push(entry)
    },
  }

  const chatPort: ChatHydratePort = {
    getHistory: (sid) => chatApi.getHistory(sid),
    isHydrated: (sid) => chat.isHydrated(sid),
    hydrate: (sid, messages) => chat.hydrate(sid, messages),
    reconcileHistory: (sid, messages) => chat.reconcileHistory(sid, messages),
    setHistoryTruncated: (sid, truncated) => useChat().setHistoryTruncated(sid, truncated),
    clearHistoryError: (sid) => chat.clearHistoryError(sid),
    markHistoryFailed: (sid) => chat.markHistoryFailed(sid),
  }

  const hooks: SessionCleanupHooks = {
    // [U7] clearBoundPanelOverlays 已随 overlay 移除从 SessionCleanupHooks 接口删除。
    clearFileTree: (sid) => useFileTreeStore().clearSession(sid),
    clearSubagent: (sid) => useSubagentStore().clearSession(sid),
    clearWorkflow: (sid) => useWorkflowStore().clearSession(sid),
    clearExtensionUI: (sid) => useExtensionUIStore().clearSession(sid),
    // M1-03：extension-host 三处 scoped map 分区（ViewHostStore/StatusBarController/OverlayLifecycle）
    // 只订阅 session-destroyed bus 事件（该事件无生产者），经 bus 显式 emit 触发分区 cleanup
    clearExtensionHost: (sid) => getExtensionBus().emit({ kind: 'session-destroyed', sessionId: sid }),
    evictChat: (sid) => chat.evictSessionWithVirtual(sid),
    // [U7] clearSubagentTombstones 已随 overlay tombstone 移除从接口删除。
    evictVirtualKeys: (sid) => {
      const workflowStore = useWorkflowStore()
      for (const acsVirtualId of workflowStore.getAgentCallVirtualIdsByMain(sid)) {
        chat.evictVirtualKey(acsVirtualId)
      }
    },
    clearAgentCallMapping: (sid) => useWorkflowStore().clearAgentCallMapping(sid),
    disposeChat: (sid) => useChat().disposeSession(sid),
    invalidateStatus: (sid) => invalidateStatusCache(sid),
  }

  const flow: NewTaskFlowPort = {
    startFlow: (presetCwd) => useNewTaskFlow().startFlow(presetCwd),
    currentSession: () => useNewTaskFlow().currentSession.value,
  }

  // ── sessionStore：pinia useSessionStore cast 成 core factory 类型（ADR-0059 cast 接缝）──
  // pinia setup store unwrap ref（外部拿值非 ref），与 core createSessionStore 返回的 ref 类型不兼容。
  // cast 是 pinia + core factory 结合的固有类型鸿沟（ADR-0059 决策 3）。createUseSession 内部经方法
  // 访问（getActiveId/setActiveId/getList），方法闭包持原始 ref，pinia/raw 双模式下都正常工作。
  const sessionStore = useSessionStore() as unknown as ReturnType<typeof createSessionStore>

  // ── core createUseSession（headless 编排；proxy 无 renderer 时序的方法）──
  const core = createUseSession({
    store: sessionStore,
    api,
    panel: panelPort,
    navigation: navigationPort,
    chat: chatPort,
    hooks,
    flow,
    // C-W5-1 债务清偿：deleteSession/deleteFolder 的 wasActive 回退走壳版 selectSession
    // （含 ensureStreamSubscription 先于 panel 载入的 renderer 时序），不再走 core headless
    // 路径。函数声明提升 + 闭包延迟求值，此处引用后文定义的 selectSession 安全。
    selectSessionFallback: (id) => selectSession(id),
  })

  /** 当前焦点 panel 绑定的 session（UI 高亮 SSOT）——代理 core.focusedSessionId */
  const focusedSessionId: ComputedRef<string | null> = core.focusedSessionId
  const focusedSession: ComputedRef<SessionSummary | null> = core.focusedSession

  /**
   * syncSessionToPanel——代理 core（无 renderer 专属时序）。
   * 单 panel 下直接载入活跃 panel，幂等。
   */
  const syncSessionToPanel = core.syncSessionToPanel

  /**
   * selectSession——壳重编排（C-W5-1，不代理 core.selectSession）。
   *
   * 完整 12 步时序（旧版自持编排的 selectSession 逐条迁移，旧轨已删）：
   * flow.cancelFlow(若活跃) → api.switchSession → sessionStore.activeId=id → clearUnread →
   * ensureStreamSubscription → chat.touchLru → syncSessionToPanel → navigation.push →
   * hydrate(若未 hydrate) → fileTree.loadTree(火忘) →
   * touchLru(panel绑定session) → evictIfNeeded。
   * [P4 s5 drawer-widget-removal] consumePendingOpen 步骤已删（pendingOpen 机制随 tasks 域移除）。
   *
   * ensureStreamSubscription 须先于 syncSessionToPanel（C-W3-4）——panel 载入后 MessageStream
   * 挂载，订阅必须先就绪否则 snapshot 回放事件被丢（2026-07-29 handoff 回复丢失事故）。
   */
  /**
   * postLoadSession —— session 载入后的通用编排（selectSession/restoreSession 共享）。
   * clearUnread → ensureStreamSubscription → touchLru → syncSessionToPanel → navigation →
   * hydrate(getHistory) → fileTree → evictIfNeeded。
   * 前置约束：调用方须先 setActiveId(id)——ensureStreamSubscription/syncSessionToPanel 依赖
   * 当前 activeId 路由到正确 session 分区（ADR-0049 + 架构约定 #7）。
   * [P4 s5 drawer-widget-removal] consumePendingOpen 步骤已删（pendingOpen 机制随 tasks 域移除）。
   */
  async function postLoadSession(id: string): Promise<void> {
    // 清除未读标记：用户主动查看该 session，不再显示未读 badge
    clearUnread(id)
    // ensureStreamSubscription：同步注册 events.on handler + fire-and-forget subscribeSession
    ensureStreamSubscription(id, chat, useSessionStoreSafe())
    // W3 H3：更新 LRU recency（在 syncSessionToPanel 之前，确保当前 session 不被驱逐）
    chat.touchLru(id)
    syncSessionToPanel(id)
    navigationPort.push({ view: 'chat', sessionId: id })
    // 历史回填/刷新（后台 session reconcile）：首次等价 hydrate；已 hydrate 则增量刷新到
    // 最新 entries（agent-managed 子 session 的 turn 可能在前端不在场时完成，一次性守卫会让
    // 最后输出永不出现）+ 保留尾部 streaming 实体（进行中轮次不断链，见 store reconcileHistory）。
    if (!chat.isHydrated(id)) {
      try {
        const { messages, historyTruncated } = await chatApi.getHistory(id)
        chat.reconcileHistory(id, messages)
        useChat().setHistoryTruncated(id, historyTruncated)
        chat.clearHistoryError(id)
      } catch {
        chat.markHistoryFailed(id)
      }
    } else {
      // 已 hydrate：静默刷新（失败不阻断——旧数据仍在，下次切入重试）
      try {
        const { messages, historyTruncated } = await chatApi.getHistory(id)
        chat.reconcileHistory(id, messages)
        // reconcile 整量替换分区：尾读（RPC 失败 fallback 20-turn）会把 load-more 前插的
        // 更早历史截回尾窗——truncated 标记必须同步刷新（对齐 core use-session 同款修复）：
        // true 时 load-more 按钮重显（hydrate 锚不被 reconcile 触碰，锚定切分仍可恢复全量）；
        // false 时清标记，与「分区已替换为全量」一致。
        useChat().setHistoryTruncated(id, historyTruncated)
      } catch (e) {
        // 已 hydrate 刷新失败不阻断切入——旧数据仍在，下次切入重试；warn 留排查痕迹
        console.warn('[useSidebar] background reconcile refresh failed for', id, e)
      }
    }
    // 文件树预加载：切 session 即拉取，侧栏「文件」tab 计数立即更新。fire-and-forget 失败不阻断。
    void useFileTree().loadTree(id)
    // [lru-panel-exempt-fix] evictIfNeeded 前刷新 panel 绑定 session 的 LRU recency
    if (panel.currentLeaf.sessionId) chat.touchLru(panel.currentLeaf.sessionId)
    chat.evictIfNeeded()
  }

  async function selectSession(id: string): Promise<void> {
    // flow 活跃（landing/overlay）时切 session → cancelled（AC-3.10，避免 overlay 卡死 + landing 残留）
    const newTaskFlow = useNewTaskFlow()
    if (newTaskFlow.isActive.value) newTaskFlow.cancelFlow()

    await sessionApi.switchSession(id)
    sessionStore.setActiveId(id)
    await postLoadSession(id)
  }

  /**
   * restoreSession —— 显式重开 dead session（重新 spawn pi）。
   * 编排对齐 selectSession，但第一步用 sessionApi.restoreSession（显式 RPC）替代 switchSession。
   * cancelFlow → restoreSession RPC → setActiveId → postLoadSession → revive（dead→idle 统一收口）。
   * 解决：模式 A（useI18n 报错——须由调用方在 setup 内解构后调闭包）、模式 B（隐式分支）。
   */
  async function restoreSession(id: string): Promise<void> {
    const newTaskFlow = useNewTaskFlow()
    if (newTaskFlow.isActive.value) newTaskFlow.cancelFlow()

    await sessionApi.restoreSession(id)
    sessionStore.setActiveId(id)
    await postLoadSession(id)
    sessionStore.revive(id)
  }

  /**
   * newSession——壳重编排（调壳版 selectSession，不代理 core.newSession）。
   * 委托 useNewTaskFlow.startFlow + selectSession 载入。返回新 id；延迟 create 返回 null。
   */
  let newTaskInFlight = false
  async function newSession(presetCwd?: string): Promise<string | null> {
    if (newTaskInFlight) return null
    newTaskInFlight = true
    try {
      const newTaskFlow = useNewTaskFlow()
      const fallback = presetCwd ?? workspaceStore.defaultCwd
      await newTaskFlow.startFlow(fallback)
      const created = newTaskFlow.currentSession.value
      if (!created) {
        // 首次启动延迟 create（AC-1.7）：无 session 可选，进 chat view 让 Panel 渲染 landing 空态
        navigationPort.push({ view: 'chat' })
        return null
      }
      // startFlow 已 appendSession + activeId=created.id；此处补 panel 载入 + history hydrate
      await selectSession(created.id)
      return created.id
    } finally {
      newTaskInFlight = false
    }
  }

  // ── 代理 core 无 renderer 时序的方法（deleteSession/deleteFolder/retryHistory/renameSession/loadSessions）──
  // deleteSession/deleteFolder 的 wasActive 回退已升级为 shell 版 selectSession（上方
  // selectSessionFallback 端口注入，C-W5-1 债务已清偿）；空态承接 [D7] push + startFlow
  // 由 core enterEmptyChatState 经 flow 端口完成（与新壳 useNewTaskFlow 同一实例）。
  const retryHistory = core.retryHistory
  const renameSession = core.renameSession
  const deleteSession = core.deleteSession
  const deleteFolder = core.deleteFolder
  const loadSessions = core.loadSessions

  /**
   * 归入项目（D14 语义修正 2026-08-04）：RPC 写归属 sidecar + 乐观更新 pinia store。
   * projectId 空串 = 归回默认项目（runtime 删除绑定）。广播 config.sessions 全量覆盖，幂等。
   * 乐观更新写 pinia store（SessionList 数据源）；raw sessionStore 由广播统一刷新。
   */
  async function assignSessionToProject(sessionId: string, projectId: string): Promise<void> {
    await sessionApi.setProject(sessionId, projectId)
    sessionStore.updateProjectId(sessionId, projectId)
  }

  /** 进入 Overview：push view:'overview'（ADR-0023，sidebar 持久，main 被覆盖） */
  function goOverview(): void {
    navigation.push({ view: 'overview' })
  }

  /** 切换折叠态（C）。展开/折叠 toggle，spec §收起态。 */
  function toggleCollapse(): void {
    sidebar.collapsed = !sidebar.collapsed
  }

  /**
   * 应用启动编排（#1/#3 启动钩子）：永远进入新建任务落地页。
   * 时序：registerAppCommands → projectStore.init（D14：create 归属读 activeProjectId，必须最前）
   * → newSession（同步进 landing）→ loadSessions → workspaceStore.load → presetCwd。
   */
  async function initApp(): Promise<void> {
    if (appBootstrapped) return
    appBootstrapped = true
    const newTaskFlow = useNewTaskFlow()
    try {
      registerAppCommands({
        newSession: () => { void newSession() },
        goOverview,
      })
      // D14（2026-08-04）：project 列表迁 runtime 持久化。init 必须在 newSession 之前——
      // createSessionFlow 读 activeProjectId 做归属透传，未 init 时 active 是默认项目（归属丢失）。
      // init 内部 RPC 失败降级默认，不抛不阻断启动。
      await useProjectStoreSafe().init()
      // 同步进 landing（空 chip 态），必须先于 await loadSessions（消除 state=idle 启动窗口）
      await newSession()
      await loadSessions()
      await workspaceStore.load()
      // 预填 cwd（G1.1「沿用最近 session 目录」）：取 sessionStore.list 中 lastActiveAt 最大者
      const sessions = sessionStore.getList()
      let recentCwd: string | undefined
      if (sessions.length > 0) {
        const latest = sessions.reduce((a, b) => (a.lastActiveAt >= b.lastActiveAt ? a : b))
        recentCwd = latest.cwd
      }
      if (!recentCwd) recentCwd = workspaceStore.defaultCwd
      if (recentCwd) newTaskFlow.presetCwd(recentCwd)
    } catch (e) {
      console.error('[useSidebar.initApp] bootstrap failed:', e)
      appBootstrapped = false
    }
  }

  /**
   * WS 连接建立/重连入口：首次 initApp；重连 fire-and-forget 刷新 workspace/extension +
   * 聚焦 session 的 subagent/workflow 列表。
   */
  async function onConnected(): Promise<void> {
    if (!hasConnectedBefore) {
      hasConnectedBefore = true
      await initApp()
      return
    }
    void workspaceStore.load()
    void extensionApi.scan().catch(() => {})
    // 重连对账（residual-fixes 附录 A-3 闭环）：runtime 侧派生缓存的刷新以 entry_appended
    // 事件为触发，重连后若无新 entry 写入（如断连前 subagent 已全部终态），侧栏将停留
    // 断连前 stale 数据直到用户切 tab。对聚焦 session 显式重拉（getSubagents/getWorkflows
    // RPC 直读磁盘，不依赖缓存事件）。load 内部 catch 降级（失败保留旧分区），
    // fire-and-forget 与上面两条刷新一致。
    const sid = focusedSessionId.value
    if (sid) {
      void useSubagentStore().loadSubagents(sid)
      void useWorkflowStore().loadWorkflows(sid)
    }
  }

  // ── fork/handoff：保持 useForkActions/useHandoffActions 组合（C-W5-4，正交职责内聚）──
  const {
    forkSession,
    forkSessionAsk,
    forkFromLastAssistant,
    enterForkModeFromLastAssistant,
  } = useForkActions(focusedSessionId as ComputedRef<string | null>)
  const {
    handoff,
    abortHandoff,
    handoffFromLastAssistant,
    enterHandoffModeFromLastAssistant,
  } = useHandoffActions(focusedSessionId as ComputedRef<string | null>)

  return {
    focusedSessionId,
    focusedSession,
    selectSession,
    restoreSession,
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
    assignSessionToProject,
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

// ── 延迟 store 获取 helper（避免循环 import + 仅在需要时实例化）──
// useSideDrawer/useSessionStore 在 selectSession/openPanel 路径按需获取，不在 setup 顶层
//（避免测试时无 pinia 报错）。
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { useSessionStore } from '@/stores/session'
import { useProjectStore } from '@/stores/project'

function useSideDrawerSafe(): ReturnType<typeof useSideDrawer> {
  return useSideDrawer()
}
function useSessionStoreSafe(): ReturnType<typeof useSessionStore> {
  return useSessionStore()
}
function useProjectStoreSafe(): ReturnType<typeof useProjectStore> {
  return useProjectStore()
}
