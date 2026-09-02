/**
 * createUseSession —— session 管理编排（IF4，w3，core 平台无关）。
 *
 * [归位] 迁自 renderer composables/features/useSidebar.ts（570 行）的 session 管理编排部分
 * （selectSession/newSession/renameSession/deleteSession/deleteFolder/loadSessions/
 * retryHistory/syncSessionToPanel + focusedSessionId/focusedSession）。原样迁移 + deps 注入：
 * 后端调用经 SessionApiPort（w2）、panel 编排经 PanelOrchestrationPort（w2 + w3 追加
 * activePanelId/findPanelBySession）、历史回填经 ChatHydratePort、导航经 NavigationPort、
 * 跨 store 清理经 SessionCleanupHooks（DM2；[U7] overlay 相关 hook 已移除）、
 * 新建任务流程经 NewTaskFlowPort（可选，C-W3-2）。core 不 import @/api / @/stores / @/composables。
 *
 * 保留契约：
 * - deleteSession 是「session 销毁唯一编排点」——triggerSessionCleanups(id)（ADR-0049 AC-8）
 *   只经本编排触发，跨 store 分区释放全在 cleanupSessionState 内按 S3 顺序执行
 *
 * [P4 s5 drawer-widget-removal] selectSession 内 consumePendingOpen / cleanupSessionState 内
 * clearPendingOpen 已删除：pendingOpen 路由机制随 tasks 域移除（PluginViewContainer 承接）。
 *
 * w5 壳组合项（本次不进 core，C-W3-4）：ensureStreamSubscription / chat.touchLru /
 * evictIfNeeded / clearUnread / fileTree 预加载 / flow.cancelFlow——壳包装本 factory 时
 * 按 renderer 时序补齐（ensureStreamSubscription 须先于 syncSessionToPanel）。
 *
 * 命名说明：IF4 字面签名写 useSession；core 内 factory 统一 create* 前缀
 * （createSessionStore/createChatStore/createUseChat 先例），故命名 createUseSession。
 */
import { computed, onScopeDispose } from 'vue'
import type { BatchDeleteResult, Message, SessionGroup, SessionSummary } from '@xyz-agent/shared'
import { triggerSessionCleanups } from '../../foundation/use-session-scoped-state'
import type { SessionApiPort, PanelOrchestrationPort } from './api-port'
import type { createSessionStore } from './store'

/**
 * 导航端口（壳注入 useNavigationStore().push 适配）。
 * core 只 push chat 路由（view:'chat' + sessionId），view 类型收窄为 string 保持平台无关。
 */
export interface NavigationPort {
  push(route: NavigationRoute): void
}

/** core 侧导航路由最小结构（壳适配 NavEntry：view 映射 + sessionId 透传） */
export interface NavigationRoute {
  view: string
  sessionId?: string | null
}

/**
 * chat 域历史回填端口（selectSession/retryHistory 的 hydrate 经此注入，壳适配
 * useChat()：isHydrated/hydrate/markHistoryFailed 等映射 chat store。
 * [P4 s5 w2] hydrateTasksFromMessages 随 tasks 域删除（原映射 tasks.hydrateFromMessages
 * 关键规则 9 持久化链路——tasks store 已删，goal/todo 快照渲染走 GuiComponentRenderer 历史消息）。
 */
export interface ChatHydratePort {
  /** 拉取 session 历史（session.history RPC；尾读可能截断） */
  getHistory(sessionId: string): Promise<{ messages: Message[]; historyTruncated: boolean }>
  /** 该 session 是否已 hydrate（幂等守卫：已回填不重复拉取） */
  isHydrated(sessionId: string): boolean
  /** 注入历史消息（chat store hydrate） */
  hydrate(sessionId: string, messages: Message[]): void
  /** 切入 reconcile：entry 历史为基线 + 分区尾部 streaming 实体保留（后台 session 切入刷新，
   *  防 pi entries 不含进行中消息导致的 delta 断链——见 chat store reconcileHistory 注释） */
  reconcileHistory(sessionId: string, messages: Message[]): void
  /** 记录截断标记（N1：截断标记供 MessageStream 显隐） */
  setHistoryTruncated(sessionId: string, historyTruncated: boolean): void
  /** 清历史加载失败态（retryHistory 先清再拉） */
  clearHistoryError(sessionId: string): void
  /** 标记历史加载失败（landing 显重试出口，不永久卡住） */
  markHistoryFailed(sessionId: string): void
}

/**
 * 跨 store 清理钩子集（DM2 + w3 追加）。deleteSession/deleteFolder 的 cleanupSessionState
 * 按 S3 顺序逐一调用；壳把 renderer 各 store 的清理方法包装传入，core 零跨包 import。
 *
 * [HISTORICAL] clearBoundPanelOverlays + clearSubagentTombstones 已随 U7 overlay 移除从接口删除
 * （overlay viewing 状态机 + tombstone 防复活均为 overlay 全屏替换模式产物，drawer tab 化后无用）。
 * 映射关系（renderer cleanupSessionState 原序）：
 * - clearFileTree → useFileTreeStore().clearSession（[P4 s5 w2] clearTasks 随 tasks 域删除）
 * - clearSubagent → subagentStore.clearSession；clearWorkflow → workflowStore.clearSession
 * - clearExtensionUI → extensionUIStore.clearSession
 * - clearExtensionHost → 壳层 bus.emit({kind:'session-destroyed', sessionId})——extension-host 的
 *   StatusBarController/ViewHostStore/OverlayLifecycle 三处 createSessionScopedMap 分区不注册
 *   triggerSessionCleanups（那是 useSessionScopedState 机制），唯一清理路径是 bus 事件，
 *   而该事件零生产者（M1-03）：必须由本编排点经 hook 显式触发
 * - evictChat → chatStore.evictSessionWithVirtual（须先于 disposeChat，D5 时序）
 * - [U7 已删] clearSubagentTombstones（overlay tombstone，随 overlay 移除）
 * - evictVirtualKeys → workflowStore.getAgentCallVirtualIdsByMain + chatStore.evictVirtualKey
 * - clearAgentCallMapping → workflowStore.clearAgentCallMapping
 * - disposeChat → useChat().disposeSession；invalidateStatus → invalidateStatusCache
 */
export interface SessionCleanupHooks {
  clearFileTree(sid: string): void
  clearSubagent(sid: string): void
  clearWorkflow(sid: string): void
  clearExtensionUI(sid: string): void
  /** extension-host per-session 分区清理（M1-03）：壳层实现 emit session-destroyed 到 InternalEventBus，
   *  触发 StatusBarController/ViewHostStore/OverlayLifecycle 的 scoped map cleanup */
  clearExtensionHost(sid: string): void
  /** chat.evictSessionWithVirtual：先按 mainSid 前缀扫 subagent 虚拟 key，再 dispose 主 session */
  evictChat(sid: string): void
  /** agentcall 两段式无 mainSid 前缀，经 workflow 映射清全部 agentcall virtualId */
  evictVirtualKeys(sid: string): void
  clearAgentCallMapping(sid: string): void
  disposeChat(sid: string): void
  invalidateStatus(sid: string): void
}

/**
 * 新建任务流程端口（C-W3-2；可选，壳未接线时 newSession 返回 null 降级）。
 * 壳适配 useNewTaskFlow（workspaceStore.defaultCwd 兜底留在壳适配层）；
 * FR5 new-task-search 域迁移后换 create-session-flow 原语，端口签名不变。
 */
export interface NewTaskFlowPort {
  /** 启动新建任务流程（延迟 create：startFlow 本身不建 session） */
  startFlow(presetCwd?: string): Promise<void>
  /** 当前流程产出的 session（null = 未创建，延迟 create 路径） */
  currentSession(): SessionSummary | null
}

/** createUseSession factory 的依赖注入接口（IF4 deps + w3 演进项） */
export interface UseSessionDeps {
  /** session 列表 store（w1 交付的纯 factory 实例，壳显式持有） */
  store: ReturnType<typeof createSessionStore>
  /** session 后端唯一通道（w2 SessionApiPort） */
  api: SessionApiPort
  /** panel 编排（w2 PanelOrchestrationPort + w3 追加 activePanelId/findPanelBySession） */
  panel: PanelOrchestrationPort
  /** 导航（壳注入 useNavigationStore().push 适配） */
  navigation: NavigationPort
  /** chat 历史回填（壳注入 useChat + tasks 适配） */
  chat: ChatHydratePort
  /** 跨 store 清理钩子（DM2 12 项） */
  hooks: SessionCleanupHooks
  /** 新建任务流程（可选；缺省时 newSession 返回 null——壳未接线状态，w5 必须接线） */
  flow?: NewTaskFlowPort
}

// ── session.list server-push 订阅（#7 方案 A；CLAUDE.md 规则 #2 防重复注册）──
// useSidebar 被 6+ 组件实例化（Sidebar/Turn/AppShell/PanelContainer/Workspace/Overview），
// 若每实例各注册一次 onGlobalType，每次广播会触发 N 次相同整表快照应用（事件处理翻倍）。
// 模块级 refCount：首个实例注册，末个实例卸载时取消，中间实例共享同一监听。
let sessionListSubCount = 0
let sessionListUnsub: (() => void) | null = null

function bindSessionListBroadcast(
  api: SessionApiPort,
  applyListSnapshot: (groups: SessionGroup[]) => void,
): void {
  sessionListSubCount += 1
  if (sessionListSubCount === 1) {
    sessionListUnsub = api.onConfigSessions((groups) => applyListSnapshot(groups))
  }
}

function unbindSessionListBroadcast(): void {
  sessionListSubCount = Math.max(0, sessionListSubCount - 1)
  if (sessionListSubCount === 0 && sessionListUnsub) {
    sessionListUnsub()
    sessionListUnsub = null
  }
}

/** 测试隔离：重置模块级订阅计数（与 resetChatModuleStateForTest 同模式，beforeEach 调）。 */
export function resetSessionListSubForTest(): void {
  if (sessionListUnsub) {
    sessionListUnsub()
    sessionListUnsub = null
  }
  sessionListSubCount = 0
}

/**
 * createUseSession factory —— session 管理编排（IF4 落地）。
 *
 * 使用方式：壳（w5）注入六端口 + 可选 flow，包装为 renderer composable（useSidebarNew）；
 * 测试注入 mock 端口断言编排（见 __tests__/use-session.test.ts）。
 */
export function createUseSession(deps: UseSessionDeps) {
  const { store, api, panel, navigation, chat, hooks } = deps

  /**
   * 当前焦点 panel 绑定的 session（UI 高亮 SSOT）。
   * 与 store.activeId 解耦：activeId 收敛为导航/启动语义，不再驱动 UI 高亮。
   * 空 panel（sessionId=null）→ 返回 null（文件树显空态占位）。
   */
  const focusedSessionId = computed<string | null>(() => panel.focusedSessionId())

  /** 焦点 session 的 summary（FileView label/branch 用）；找不到则 null */
  const focusedSession = computed<SessionSummary | null>(
    () => store.getList().find((s) => s.id === focusedSessionId.value) ?? null,
  )

  /**
   * session.list server-push 订阅（#7 方案 A）。
   * runtime 在 create/delete/rename 后 broadcastSessionList 推全量分组，
   * 这里 applySnapshot（整表形态）更新列表——只换列表，不重载历史。
   * refCount + onScopeDispose：多实例只注册一次，随组件卸载自动收尾。
   */
  bindSessionListBroadcast(api, (groups) => store.applySnapshot({ groups }))
  onScopeDispose(unbindSessionListBroadcast)

  /**
   * 同步 session 到 panel（sidebar 选 session 与 ⌘[/⌘] 导航共用）。
   * 单 panel 下直接载入活跃 panel。幂等：同 sessionId 重复调用，loadSession 同值不变。
   * 编排点在 features 层而非组件 watch——避免「空态时不渲染→watch 不注册→loadSession 不触发」
   * 的初始化时序死锁（原 PanelContainer watch bug）。
   */
  function syncSessionToPanel(sessionId: string): void {
    const pid = panel.activePanelId()
    if (pid) panel.loadSession(pid, sessionId)
  }

  /**
   * 选择 session：switchSession api + 更新 activeId + 载入 panel + 首次历史回填。
   * switchSession 失败（mock id 不存在）抛错，UI 层捕获；不更新 activeId。
   *
   * 首次进入该 session 时拉取历史注入 chat store（UC-2 切换可见块类型丰富度）。
   * getHistory 失败 → 标记 failedHistory，landing 显重试出口（AC-2.6），不永久卡住——
   * 失败消化不抛（主流程不因 hydrate 失败中断）。
   *
   * 非 core 编排项（ensureStreamSubscription/touchLru/evictIfNeeded/clearUnread/fileTree
   * 预加载/flow.cancelFlow）由 w5 壳组合层补齐（C-W3-4），保持 renderer 时序。
   */
  async function selectSession(id: string): Promise<void> {
    await api.switchSession(id)
    store.setActiveId(id)
    // 历史回填：features 层跨 api+stores，是 hydrate 的正确编排点
    // 切入刷新（后台 session reconcile）：首次等价 hydrate；已 hydrate 则增量刷新到最新
    // entries（turn 可能在前端不在场时完成）+ 保留尾部 streaming 实体（进行中轮次不断链）。
    if (!chat.isHydrated(id)) {
      try {
        const { messages, historyTruncated } = await chat.getHistory(id)
        chat.reconcileHistory(id, messages)
        chat.setHistoryTruncated(id, historyTruncated) // N1: 截断标记供 MessageStream 显隐
        chat.clearHistoryError(id)
      } catch {
        chat.markHistoryFailed(id)
      }
    } else {
      // 已 hydrate：静默刷新（失败不阻断——旧数据仍在，下次切入重试）
      try {
        const { messages, historyTruncated } = await chat.getHistory(id)
        chat.reconcileHistory(id, messages)
        // reconcile 整量替换分区：getHistory 尾读（RPC 失败 fallback 20-turn）会把
        // load-more 前插的更早历史截回尾窗——truncated 标记必须同步刷新，true 时
        // load-more 按钮重显（hydrate 锚不被 reconcile 触碰，锚定切分仍可恢复全量）；
        // false（RPC 全量成功）时清标记与「分区已替换为全量」一致。
        chat.setHistoryTruncated(id, historyTruncated)
      } catch (e) {
        // 已 hydrate 刷新失败不阻断切入——旧数据仍在，下次切入重试；warn 留排查痕迹
        console.warn(`[use-session] background reconcile refresh failed for ${id}:`, e)
      }
    }
    syncSessionToPanel(id)
    navigation.push({ view: 'chat', sessionId: id })
  }

  /**
   * 重试加载历史（landing 重试按钮，#2 AC-2.6）：清失败态 + 重新拉取 hydrate。
   */
  async function retryHistory(sessionId: string): Promise<void> {
    chat.clearHistoryError(sessionId)
    try {
      const { messages, historyTruncated } = await chat.getHistory(sessionId)
      chat.reconcileHistory(sessionId, messages)
      chat.setHistoryTruncated(sessionId, historyTruncated)
    } catch {
      chat.markHistoryFailed(sessionId)
    }
  }

  /**
   * 新建 session（延迟 create 语义，C-W3-2）：委托 NewTaskFlowPort.startFlow 编排状态机
   * （startFlow 本身不建 session——首次启动 AC-1.7 路径），流程产出 session 再 selectSession 载入。
   * 返回新 session id；延迟 create 时返回 null（Panel 渲染 landing 空态）。
   *
   * per-instance in-flight 守卫（renderer 同构：6+ 组件实例各自独立守卫，模块级会互相阻塞）。
   * flow 未接线（deps.flow 缺省）时返回 null 降级——壳（w5）接线后语义完整。
   */
  let newTaskInFlight = false
  async function newSession(presetCwd?: string): Promise<string | null> {
    if (newTaskInFlight) return null
    if (!deps.flow) return null
    newTaskInFlight = true
    try {
      await deps.flow.startFlow(presetCwd)
      const created = deps.flow.currentSession()
      if (!created) {
        // 首次启动延迟 create（AC-1.7）：无 session 可选，进 chat view 让 Panel 渲染 landing 空态
        navigation.push({ view: 'chat' })
        return null
      }
      // startFlow 已负责 appendSession + activeId 同步；此处只补 panel 载入 + history hydrate
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
    await api.rename(id, label)
    store.applySnapshot(id, { label })
  }

  /**
   * 单 session 的本地状态清理（panel 解绑 + 跨 store 分区释放）。
   *
   * 从 deleteSession 主体提取（供 deleteFolder 复用）：删 session 后同步清 panel 绑定 +
   * 全部 per-session store 分区 + 派生状态缓存，防内存泄漏与悬空引用。
   * 与 deleteSession 不同——这里不做 WS 删除（调用方已保证 session 在后端已删），
   * 也不做 wasActive 回退（deleteFolder 统一在循环结束后回退）。
   *
   * S3 顺序（与 renderer cleanupSessionState 逐条对齐）：
   * panel 解绑 → overlay 清理 → removeFromList →
   * 12 项跨 store 钩子（clearFileTree→…→invalidateStatus）→ triggerSessionCleanups。
   */
  function cleanupSessionState(id: string): void {
    // 删除的 session 若绑定到 panel，清空 panel 绑定，避免悬空引用指向已删 session。
    const boundPanel = panel.findPanelBySession(id)
    if (boundPanel) {
      panel.loadSession(boundPanel.id, null)
      // [U7] overlay viewing 状态机已移除，clearBoundPanelOverlays 兜底清理随之删除。
      // 虚拟 key 清理走下面 evictChat（subagent: 前缀）+ evictVirtualKeys（agentcall 映射）两条独立路径。
    }
    store.removeFromList(id)
    // 跨 store 清理（S3）：fileTree + subagent + workflow + extensionUI + chat evict
    // + tombstones + agentcall virtuals + dispose + 派生状态缓存（[P4 s5 w2] tasks 已删）
    hooks.clearFileTree(id)
    // ADR-0049 Map 分区派：释放 subagent/workflow/extensionUI 的 per-session 分区（防泄漏，AC-8）
    hooks.clearSubagent(id)
    hooks.clearWorkflow(id)
    hooks.clearExtensionUI(id)
    // M1-03：extension-host 三处 scoped map 分区（ViewHostStore/StatusBarController/OverlayLifecycle）
    // 只订阅 session-destroyed bus 事件，而该事件无生产者——本编排点必须显式触发清理
    hooks.clearExtensionHost(id)
    // evictSessionWithVirtual 在 disposeSession 之前：先按 mainSid 前缀扫 subagent 虚拟 key，
    // 再 dispose 主 session（dispose 后主记录已删，evict 无法反查）。D5 时序。
    hooks.evictChat(id)
    // agentcall 两段式无 mainSid 前缀，经 workflow 映射清全部 agentcall virtualId
    hooks.evictVirtualKeys(id)
    hooks.clearAgentCallMapping(id)
    hooks.disposeChat(id)
    // 清除该 session 的 derivedStatus/sessionDigest 缓存，避免已删 session 的 computed 残留
    hooks.invalidateStatus(id)
    // ADR-0049 W5：触发所有 useSessionScopedState 实例清理该 sid 的 Map 分区，
    // 防已销毁 session 的 per-session 状态条目在 Map 中积累导致内存泄漏（AC-8）。
    // 销毁唯一编排点契约：triggerSessionCleanups 只经 deleteSession/deleteFolder 触发。
    triggerSessionCleanups(id)
  }

  /**
   * 删除 session（API + 本地状态清理）。
   * 删除当前 active 时回退到列表首项（若无则停留空态）。
   *
   * S3 跨 store 清理由 cleanupSessionState 统一承担（panel 解绑 + 全部 per-session 分区释放）。
   * S4 / ES1 fallback：删 active 后 selectSession(next) 失败兜底——cleanupSessionState 已把
   * activeId 回退到 list[0]，若随后的 selectSession(next) 因网络抖动 reject，activeId=next 但
   * panel 空载 → 跨 store 撕裂。失败时 fallback 到 navigation.push({ view: 'chat' }) 空态。
   */
  async function deleteSession(id: string): Promise<void> {
    await api.remove(id)
    const wasActive = store.getActiveId() === id
    cleanupSessionState(id)
    if (wasActive) {
      const next = store.getList()[0]
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
   * 调 api.removeByCwd 拿 BatchDeleteResult，对 res.deleted 逐个调
   * cleanupSessionState（复用 deleteSession 提取的清理逻辑）。wasActiveInFolder
   * 在调 WS 前快照，循环结束后统一回退（不依赖 removeFromList 中间态）。
   * 返回 BatchDeleteResult——caller（Sidebar.onDeleteFolder）读 res.failed 决定 toast。
   */
  async function deleteFolder(cwd: string): Promise<BatchDeleteResult> {
    // 用已派生的 store.list（单一真源 groups → list，与下文回退 store.list[0] 同源），
    // 避免再 flatMap 一次重复 groups.flatMap(g => g.sessions)。
    const wasActiveInFolder = store.getList()
      .filter((s) => s.cwd === cwd)
      .some((s) => s.id === store.getActiveId())
    const res = await api.removeByCwd(cwd)
    for (const sid of res.deleted) {
      cleanupSessionState(sid)
    }
    if (wasActiveInFolder) {
      const next = store.getList()[0]
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

  /**
   * 加载 session 列表（去全量预 hydrate）。
   * 铁律 1：api 调用只在 features 层，组件不直接 import api。
   * sessionApi.list() 返 SessionGroup[]（按 cwd 分组，D7），applySnapshot 整表形态填入分组真源。
   * 失败（ES2/S5）：setListLoadError(msg)，SessionList 据此显示「加载失败，点击重试」。
   */
  async function loadSessions(): Promise<void> {
    try {
      const groups = await api.list()
      store.applySnapshot({ groups })
      store.setListLoadError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      store.setListLoadError(msg)
    }
  }

  return {
    focusedSessionId,
    focusedSession,
    syncSessionToPanel,
    selectSession,
    retryHistory,
    newSession,
    renameSession,
    deleteSession,
    deleteFolder,
    loadSessions,
  }
}
