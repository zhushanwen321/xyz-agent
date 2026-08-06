/**
 * useSidebarNew —— 新壳 sidebar/session 接缝 composable（w5，绞杀接缝）。
 *
 * [归位] 这是 session-sidebar 域 P3 绞杀的「壳集成」产物：包装 core createUseSession（w3）
 * + 注入 5 端口适配（SessionApiPort/PanelOrchestrationPort/NavigationPort/ChatHydratePort/
 * SessionCleanupHooks）+ renderer 专属编排。与现 useSidebar.ts 返回签名对齐（C-W5-4）。
 *
 * 关键裁决：
 * - C-W5-1：selectSession/newSession 壳重编排（不代理 core.selectSession）——core.selectSession
 *   是闭合函数，renderer 专属步骤（ensureStreamSubscription 须先于 syncSessionToPanel / LRU /
 *   clearUnread / fileTree 预加载 / flow.cancelFlow）无法插入其内部。core.selectSession 留
 *   headless/mobile 消费。deleteSession/deleteFolder 代理 core（wasActive 回退走 core.selectSession
 *   headless 路径——w5 接缝期接受，消费方切换 wave 升级为 shell.selectSession，见 retrospect 债务）。
 * - C-W5-5：sessionStore 自建 raw createSessionStore() 实例（接缝本地，与 pinia useSessionStore
 *   并存）——core createUseSession 碰 ref（store.activeId.value），pinia proxy 实测不保留 .value，
 *   cast 静默失效；raw 实例使 .value 生效。其他 store 经端口适配以方法调用访问（pinia/raw 均可）。
 *
 * 边界（C-W4-3 / FU-1）：thinkingLevel apply / panel.loadSession / navigation.push / send /
 * transition 留 useNewTaskFlow 壳（submitFirstMessage 改调 core createSessionFlow，见该文件）。
 *
 * 消费状态（C-W5-4）：w5 只建接缝 + 首屏冒烟，不动 useSidebar 的 10+ 消费方（新旧共存至后续 wave）。
 *
 * 命名说明：useSidebarNew 是临时接缝名，消费方切换完成后（后续 wave）重命名取代 useSidebar。
 */
import { onScopeDispose } from 'vue'
import type { ComputedRef } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'
import {
  createSessionStore,
  createUseSession,
  consumePendingOpen,
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
import { useSubagentStore, clearSubagentTombstones } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useChat, ensureStreamSubscription } from '@/composables/features/chat/useChat'
import { invalidateStatusCache } from '@/composables/features/chat/useSessionDerivations'
import { clearUnread } from '@/composables/useSessionMarkers'
import { registerAppCommands } from '@/composables/features/command/useAppCommands'
import { useForkActions } from '@/composables/features/fork-handoff/useForkActions'
import { useHandoffActions } from '@/composables/features/fork-handoff/useHandoffActions'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import type { NavEntry } from '@/types'

// ── App 启动编排幂等守卫（与 useSidebar 同模式；接缝期独立，不与 useSidebar 共享——
// useSidebarNew 未被生产消费方接线，两套守卫不会并发触发）──
let appBootstrapped = false
let hasConnectedBefore = false

/** 测试隔离：重置启动编排守卫 + session.list 订阅计数 + 桥接计数器（beforeEach 调）。 */
export function resetSidebarNewForTest(): void {
  appBootstrapped = false
  hasConnectedBefore = false
  resetSessionListSubForTest()
  resetSessionListBroadcastForTest()
}

/** 测试隔离：重置 config.sessions→pinia 桥接的模块级 refCount（防跨测试监听残留）。 */
export function resetSessionListBroadcastForTest(): void {
  sessionListUnsub?.()
  sessionListUnsub = null
  broadcastRefCount = 0
}

// ── config.sessions 广播桥接 → pinia useSessionStore（CLAUDE.md 规则 #2 防重复注册）──
// 双 store 断裂修复：core createUseSession 经 onConfigSessions 把 config.sessions 广播写入
// 接缝本地 raw store（C-W5-5），而 Sidebar SessionList 读 pinia useSessionStore —— 两 store
// 完全独立导致侧栏永远空列表。此桥接把同一广播镜像 setGroups 到 pinia store，双 store 数据一致。
// 模块级 refCount：多实例共享同一监听（首个注册、末个卸载），防止事件处理翻倍。
let broadcastRefCount = 0
let sessionListUnsub: (() => void) | null = null

function bindSessionListBroadcast(): void {
  broadcastRefCount += 1
  if (broadcastRefCount === 1) {
    sessionListUnsub = events.onGlobalType('config.sessions', (msg) => {
      useSessionStoreSafe().setGroups(msg.payload?.groups ?? [])
    })
  }
}

function unbindSessionListBroadcast(): void {
  broadcastRefCount = Math.max(0, broadcastRefCount - 1)
  if (broadcastRefCount === 0 && sessionListUnsub) {
    sessionListUnsub()
    sessionListUnsub = null
  }
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

export function useSidebarNew() {
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
    openPanel: (panelId, sid) => {
      // tasks drawer 经 useSideDrawer.open('tasks')；sideDrawer 经 open（sid 由 drawer 内部路由）
      const { open } = useSideDrawerSafe()
      if (panelId === 'tasks') open('tasks')
      else open()
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
    setHistoryTruncated: (sid, truncated) => useChat().setHistoryTruncated(sid, truncated),
    clearHistoryError: (sid) => chat.clearHistoryError(sid),
    markHistoryFailed: (sid) => chat.markHistoryFailed(sid),
  }

  const hooks: SessionCleanupHooks = {
    clearBoundPanelOverlays: (boundPanelId, sid) => {
      const subagentStore = useSubagentStore()
      const workflowStore = useWorkflowStore()
      if (subagentStore.isViewing(boundPanelId)) {
        const viewingSubId = subagentStore.getViewingSubagentId(boundPanelId)
        subagentStore.backToMain(
          boundPanelId,
          sid,
          viewingSubId ?? undefined,
          (vsid) => useChatStore().evictVirtualKey(vsid),
        )
      }
      if (workflowStore.isViewing(boundPanelId)) {
        workflowStore.backFromAgentCall(
          boundPanelId,
          (acsId) => useChatStore().evictVirtualKey(acsId),
          sid,
        )
      }
    },
    clearFileTree: (sid) => useFileTreeStore().clearSession(sid),
    clearSubagent: (sid) => useSubagentStore().clearSession(sid),
    clearWorkflow: (sid) => useWorkflowStore().clearSession(sid),
    clearExtensionUI: (sid) => useExtensionUIStore().clearSession(sid),
    evictChat: (sid) => chat.evictSessionWithVirtual(sid),
    clearSubagentTombstones: (sid) => clearSubagentTombstones(sid),
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

  // ── 接缝本地 sessionStore（raw createSessionStore 实例，C-W5-5）──
  // core createUseSession 碰 ref（store.activeId.value），pinia proxy 不保留 .value，
  // 故自建 raw 实例。pinia useSessionStore 不动（旧消费方继续读），合并留后续 wave。
  const sessionStore = createSessionStore()

  // ── core createUseSession（headless 编排；proxy 无 renderer 时序的方法）──
  const core = createUseSession({
    store: sessionStore,
    api,
    panel: panelPort,
    navigation: navigationPort,
    chat: chatPort,
    hooks,
    flow,
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
   * 完整 13 步时序（对照现 useSidebar.selectSession 逐条迁移）：
   * flow.cancelFlow(若活跃) → api.switchSession → sessionStore.activeId=id → clearUnread →
   * ensureStreamSubscription → chat.touchLru → syncSessionToPanel → navigation.push →
   * hydrate(若未 hydrate) → consumePendingOpen → fileTree.loadTree(火忘) →
   * touchLru(panel绑定session) → evictIfNeeded。
   *
   * ensureStreamSubscription 须先于 syncSessionToPanel（C-W3-4）——panel 载入后 MessageStream
   * 挂载，订阅必须先就绪否则 snapshot 回放事件被丢（2026-07-29 handoff 回复丢失事故）。
   */
  async function selectSession(id: string): Promise<void> {
    // flow 活跃（landing/overlay）时切 session → cancelled（AC-3.10，避免 overlay 卡死 + landing 残留）
    const newTaskFlow = useNewTaskFlow()
    if (newTaskFlow.isActive.value) newTaskFlow.cancelFlow()

    await sessionApi.switchSession(id)
    sessionStore.activeId.value = id
    // 清除未读标记：用户主动查看该 session，不再显示未读 badge
    clearUnread(id)
    // ensureStreamSubscription：同步注册 events.on handler + fire-and-forget subscribeSession
    ensureStreamSubscription(id, chat, useSessionStoreSafe())
    // W3 H3：更新 LRU recency（在 syncSessionToPanel 之前，确保当前 session 不被驱逐）
    chat.touchLru(id)
    syncSessionToPanel(id)
    navigationPort.push({ view: 'chat', sessionId: id })
    // 历史回填：首次进入该 session 拉取历史注入 chat store（getHistory 失败消化不阻断）
    if (!chat.isHydrated(id)) {
      try {
        const { messages, historyTruncated } = await chatApi.getHistory(id)
        chat.hydrate(id, messages)
        useChat().setHistoryTruncated(id, historyTruncated)
        chat.clearHistoryError(id)
      } catch {
        chat.markHistoryFailed(id)
      }
    }
    // pendingOpen 消费（FR-3 / C-SS-3）：切到该 session 后消费标记——若有则自动开对应 tab
    consumePendingOpen(id, panelPort)
    // 文件树预加载：切 session 即拉取，侧栏「文件」tab 计数立即更新。fire-and-forget 失败不阻断。
    void useFileTree().loadTree(id)
    // [lru-panel-exempt-fix] evictIfNeeded 前刷新 panel 绑定 session 的 LRU recency
    if (panel.currentLeaf.sessionId) chat.touchLru(panel.currentLeaf.sessionId)
    chat.evictIfNeeded()
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
  // 边界债务：deleteSession/deleteFolder 的 wasActive 回退走 core.selectSession（headless 路径，
  // 缺 ensureStreamSubscription），w5 接缝期接受；消费方切换 wave 升级为 shell.selectSession。
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
    useSessionStoreSafe().updateProjectId(sessionId, projectId)
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
   * 对照 useSidebar.initApp，newSession 调壳版（含 renderer 专属编排）。
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
      const sessions = sessionStore.list.value
      let recentCwd: string | undefined
      if (sessions.length > 0) {
        const latest = sessions.reduce((a, b) => (a.lastActiveAt >= b.lastActiveAt ? a : b))
        recentCwd = latest.cwd
      }
      if (!recentCwd) recentCwd = workspaceStore.defaultCwd
      if (recentCwd) newTaskFlow.presetCwd(recentCwd)
    } catch (e) {
      console.error('[useSidebarNew.initApp] bootstrap failed:', e)
      appBootstrapped = false
    }
  }

  /** WS 连接建立/重连入口：首次 initApp；重连 fire-and-forget workspaceStore.load + extensionApi.scan。 */
  async function onConnected(): Promise<void> {
    if (!hasConnectedBefore) {
      hasConnectedBefore = true
      await initApp()
      return
    }
    void workspaceStore.load()
    void extensionApi.scan().catch(() => {})
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

  // ── 桥接注册：config.sessions 广播镜像到 pinia useSessionStore（refCount 防翻倍）──
  // 与 core 的 onConfigSessions（写 raw store）并存：同一广播双写，pinia store 供 SessionList 读。
  bindSessionListBroadcast()

  // 持有引用避免 onScopeDispose 前实例被回收（core.createUseSession 内部已 bind + dispose）
  onScopeDispose(() => {
    // 桥接解绑：refCount 减一，减到 0 才真正 off
    unbindSessionListBroadcast()
    // core.createUseSession 内部 onScopeDispose(unbindSessionListBroadcast) 已注册，
    // 此处空 dispose 占位保持显式生命周期锚点（未来壳级 cleanup 扩展点）。
  })

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
    assignSessionToProject,
    forkSession,
    forkSessionAsk,
    forkFromLastAssistant,
    enterForkModeFromLastAssistant,
    handoff,
    abortHandoff,
    handoffFromLastAssistant,
    enterHandoffModeFromLastAssistant,
    /**
     * @internal 测试句柄：暴露接缝本地 raw sessionStore 供集成测试 seed（setGroups/断言 activeId）。
     * 生产消费方不读此字段。接缝本地 store 与 pinia useSessionStore 并存（C-W5-5）。
     */
    __testStore: sessionStore,
  }
}

// ── 延迟 store 获取 helper（避免循环 import + 仅在需要时实例化）──
// useSideDrawer/useSessionStore 在 selectSession/openPanel 路径按需获取，不在 setup 顶层（保持与
// useSidebar 实例化时机一致，避免测试时无 pinia 报错）。
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
