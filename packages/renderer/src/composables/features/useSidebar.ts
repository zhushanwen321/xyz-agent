/**
 * useSidebar —— sidebar 业务编排（R2 features 层）。
 *
 * 这是「唯一跨 api + stores 的层」（R2 铁律 1）：组合 navigation/session/chat/sidebar
 * 四个 store 与 api.session 域，编排 sidebar 的核心动作。
 *
 * 暴露动作：
 * - selectSession(id)：push 导航栈 + switchSession api + 更新 session.activeId（UC-3）
 * - newSession()：create api + push + select（UC-2）
 * - goOverview()：push view:'overview'（ADR-0022，main 区被 Overview 覆盖）
 * - toggleCollapse()：切换 sidebar.collapsed（折叠态 C）
 *
 * 重构演进（2026-07-02 架构返工 C3）：派生状态（derivedStatus / sessionDigest）原在本 composable，
 * 现抽到 useSessionDerivations 轻量 composable（composables/features/useSessionDerivations.ts）。
 * 派生纯函数 deriveStatus 下沉到 composables/logic/sessionStatus.ts（与 DOT_CLASS 同源 5 态 SSOT）。
 * 本 composable 保留 session CRUD + panel/nav 同步 + hydrate + 命令时序 + 文件树预触发 + initApp
 * （核心粘合价值，deletion test 证明不可删）。
 *
 * deriveStatus 仍从此处 re-export（向后兼容：历史上有调用方直接从 useSidebar import 该纯函数）。
 */
import { computed, onScopeDispose } from 'vue'
import type { SessionGroup } from '@xyz-agent/shared'
import { segmentsToPrompt, textToSegments } from '@xyz-agent/shared'
import { chat as chatApi, session as sessionApi, extension as extensionApi } from '@/api'
import * as events from '@/api/events'
import { useChatStore } from '@/stores/chat'
import { useCommandStore } from '@/stores/command'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import { useTasksStore } from '@/stores/tasks'
import { useWorkspaceStore } from '@/stores/workspace'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useFileTree } from '@/composables/features/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSubagentStore, clearSubagentTombstones } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useChat } from '@/composables/features/useChat'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import { invalidateStatusCache } from '@/composables/features/useSessionDerivations'
import { registerAppCommands } from '@/composables/features/useAppCommands'
// deriveStatus 纯函数 re-export（向后兼容：旧调用方直接从 useSidebar import）
export { deriveStatus } from '@/composables/logic/sessionStatus'

// 模块级 i18n t（非 setup 上下文也能用，与 useChat 同模式）
const t = i18n.global.t

// ── session.list server-push 订阅（#7 方案 A；CLAUDE.md 规则 #2 防重复注册）──
// useSidebar 被 6+ 组件实例化（Sidebar/Turn/AppShell/PanelContainer/Workspace/Overview），
// 若每实例各注册一次 onGlobalType，每次广播会触发 N 次相同 setGroups（事件处理翻倍）。
// 模块级 refCount：首个实例注册，末个实例卸载时取消，中间实例共享同一监听。
let sessionListSubCount = 0
let sessionListUnsub: (() => void) | null = null

function bindSessionListBroadcast(setGroups: (groups: SessionGroup[]) => void): void {
  sessionListSubCount += 1
  if (sessionListSubCount === 1) {
    sessionListUnsub = events.onGlobalType('config.sessions', (msg) => setGroups(msg.payload.groups))
  }
}

function unbindSessionListBroadcast(): void {
  sessionListSubCount = Math.max(0, sessionListSubCount - 1)
  if (sessionListSubCount === 0 && sessionListUnsub) {
    sessionListUnsub()
    sessionListUnsub = null
  }
}

/**
 * app.info 订阅（refCount 保护，同 sessionListBroadcast 模式）。
 * 提取 publicSessionId（公共 session，runtime 启动期创建）：
 * - 存入 sessionStore.publicSessionId（landing 态 composer fallback 用）
 * - 拉取公共 session 的 pi 命令到 commandStore（key=公共 sid），landing slash popover 据此渲染
 * /goal 等 extension 命令。publicSessionId 缺失（model 未配置）时跳过，landing 降级到 skills。
 */
let appInfoSubCount = 0
let appInfoUnsub: (() => void) | null = null

function bindAppInfoBroadcast(
  session: ReturnType<typeof useSessionStore>,
  commandStore: ReturnType<typeof useCommandStore>,
): void {
  appInfoSubCount += 1
  if (appInfoSubCount === 1) {
    appInfoUnsub = events.onGlobalType('app.info', async (msg) => {
      const sid = msg.payload.publicSessionId
      if (!sid || session.publicSessionId === sid) {
        // 无公共 session（model 未配置）或 id 未变，只存 id（首次设值）
        if (sid) session.publicSessionId = sid
        return
      }
      session.publicSessionId = sid
      // 拉取公共 session 命令到 commandStore（landing 态 slash popover 数据源）
      try {
        const { commands } = await sessionApi.getCommands(sid)
        commandStore.applyCommands(sid, commands)
      // eslint-disable-next-line taste/no-silent-catch -- 公共 session 命令拉取失败：landing slash 降级到 skills fallback，不阻塞
      } catch (e) {
        console.warn('[useSidebar] public session getCommands failed, landing slash will use skills fallback:', e)
      }
    })
  }
}

function unbindAppInfoBroadcast(): void {
  appInfoSubCount = Math.max(0, appInfoSubCount - 1)
  if (appInfoSubCount === 0 && appInfoUnsub) {
    appInfoUnsub()
    appInfoUnsub = null
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

export function useSidebar() {
  const navigation = useNavigationStore()
  const session = useSessionStore()
  const chat = useChatStore()
  const tasks = useTasksStore()
  const sidebar = useSidebarStore()
  const panel = usePanelStore()
  const commandStore = useCommandStore()
  const workspaceStore = useWorkspaceStore()

  /**
   * 当前焦点 panel 绑定的 session（UI 高亮 SSOT）。
   * 从 panel.activePanelId 派生——切 panel focus 时自动跟随，驱动 sidebar 高亮 / 文件树 / overview。
   * 与 session.activeId 解耦：activeId 收敛为导航/启动语义，不再驱动 UI 高亮。
   * 双 panel standby 空态（leaf.sessionId=null）→ 返回 null（文件树显空态占位）。
   */
  const focusedSessionId = computed<string | null>(
    () => panel.panels.find((p) => p.id === panel.activePanelId)?.sessionId ?? null,
  )

  /** 焦点 session 的 summary（FileView label/branch 用）；找不到则 null */
  const focusedSession = computed(
    () => session.list.find((s) => s.id === focusedSessionId.value) ?? null,
  )

  /**
   * session.list server-push 订阅（#7 方案 A）。
   * runtime 在 create/delete/rename 后 broadcastSessionList 推全量分组（server.ts:322），
   * 这里 setGroups 更新列表——只换列表，不重载历史（history hydrate 仅 loadSessions/按需做）。
   * 与 newSession/deleteSession/renameSession 的本地乐观更新互补：乐观更新让 UI 即时响应，
   * 广播随后用 runtime 权威分组对齐（同一 store，重复写入幂等）。
   * refCount + onScopeDispose：useSidebar 多实例只注册一次，随组件卸载自动收尾。
   */
  bindSessionListBroadcast(session.setGroups)
  onScopeDispose(unbindSessionListBroadcast)
  // app.info 订阅：提取 publicSessionId + 拉取公共 session 命令（landing slash popover 数据源）
  bindAppInfoBroadcast(session, commandStore)
  onScopeDispose(unbindAppInfoBroadcast)

  /**
   * 同步 session 到 panel（sidebar 选 session 与 ⌘[/⌘] 导航共用）。
   * session 已在某 panel 则只切焦点，否则载入 active panel（单 panel 默认根节点）。
   * 幂等：同 sessionId 重复调用无副作用（findPanelBySession 命中→setActive，loadSession 同值不变）。
   *
   * 编排点在 features 层而非组件 watch——避免「空态时不渲染→watch 不注册→loadSession 不触发」
   * 的初始化时序死锁（原 PanelContainer watch bug，W05 发现）。
   */
  function syncSessionToPanel(sessionId: string): void {
    const existing = panel.findPanelBySession(sessionId)
    if (existing) {
      panel.setActive(existing.id)
    } else {
      panel.loadSession(panel.activePanelId, sessionId)
    }
  }

  /**
   * 选择 session：push 导航栈（view:chat + sessionId）+ switchSession api + 更新 activeId + 载入 panel。
   * 首次进入该 session 时拉取历史注入 chat store（UC-2 切换可见块类型，G2-006）。
   * switchSession 失败（mock id 不存在）抛错，UI 层捕获；不更新 activeId。
   *
   * opts.panelId：强制载入指定 panel（而非默认的 active/sync 路径），用于「新建会话替换待机侧」——
   * 载入待机 panel 并 setActive 聚焦，active 侧 session 不动（panel/spec.md 状态与交互）。
   *
   * NewTaskFlow 联动（#3 AC-3.10）：flow 活跃时（landing/overlay）切 session → cancelFlow，
   * 让 flow 退到 cancelled（overlay 自动关 + state 不残留 landing）。
   * landing 态覆盖：initApp/点新建后停在 landing，此时点侧栏历史会话须 cancelFlow，
   * 否则 state 残留 landing → isLandingView 仍 true → composer 被误抑制（new-task 渲染撕裂）。
   */
  async function selectSession(id: string, opts?: { panelId?: string }): Promise<void> {
    // flow 活跃（landing/overlay）时切 session → cancelled（AC-3.10，避免 overlay 卡死 + landing 残留）
    const flow = useNewTaskFlow()
    if (flow.isActive.value) flow.cancelFlow()

    await sessionApi.switchSession(id)
    session.activeId = id
    // W3 H3：更新 LRU recency（在 evictIfNeeded 之前，确保当前 session 不被驱逐，R3/R4 修复）
    chat.touchLru(id)
    if (opts?.panelId) {
      panel.loadSession(opts.panelId, id)
      panel.setActive(opts.panelId)
    } else {
      syncSessionToPanel(id)
    }
    navigation.push({ view: 'chat', sessionId: id })
    // 历史回填：features 层跨 api+stores，是 hydrate 的正确编排点
    // getHistory 失败 → 标记 failedHistory，landing 显重试出口（AC-2.6），不永久卡住
    if (!chat.isHydrated(id)) {
      try {
        const { messages, historyTruncated } = await chatApi.getHistory(id)
        chat.hydrate(id, messages)
        tasks.hydrateFromMessages(id, messages) // 规则 7.5：重开 session 后 goal/todo 快照仍可见
        useChat().setHistoryTruncated(id, historyTruncated) // N1: 截断标记供 MessageStream 显隐
        chat.clearHistoryError(id)
      } catch {
        chat.markHistoryFailed(id)
      }
    }
    // 命令拉取：修复 broadcast 与订阅时序竞争——session.switch 的 ensureActive 内部
    // broadcast session.commands 发生在本函数 await switchSession resolve 之前，
    // 此时 session.activeId 还是旧值，CommandPopover 未订阅新 sessionId 通道，broadcast 被丢弃。
    // 这里在 activeId 更新（订阅已重订）后主动拉取并本地 dispatch，保证命令到达订阅者。
    // 同时写入 commandStore（持久化，组件 v-if 重建后仍可读，修复 slash 浮层对话后失效）。
    // getCommands 失败不阻断切 session（命令缺失不致命，输入 / 时浮层空，可后补）。
    try {
      const { commands } = await sessionApi.getCommands(id)
      commandStore.applyCommands(id, commands)
      events.dispatchSession(id, { type: 'session.commands', payload: { sessionId: id, commands } })
      // eslint-disable-next-line taste/no-silent-catch -- getCommands 失败不阻断 session 切换（命令缺失仅致 slash 浮层空，可后补）；与 runtime fetchAndBroadcastCommands 同策略
    } catch (e) {
      console.warn('[useSidebar] getCommands failed, slash popover will be empty:', e)
    }

    // 上下文用量拉取：修复 broadcast 与订阅时序竞争——restoreSession 内部的兜底 broadcast
    // 早于前端订阅新 sessionId 通道被丢弃；这里在 activeId 更新后主动拉取并本地 dispatch，
    // 保证 ContextCapacityPopover 拿到旧 session 恢复后的当前用量（pi 从历史估算 contextUsage）。
    // 失败不阻断切 session（用量缺失仅致 popover 不显数字，下个 turn_end 自然刷新）。
    try {
      const ctx = await sessionApi.getContext(id)
      events.dispatchSession(id, { type: 'context.update', payload: ctx })
      // eslint-disable-next-line taste/no-silent-catch -- context 拉取失败不阻断 session 切换（用量缺失仅致 popover 暂空，等下个 turn_end 刷新）
    } catch (e) {
      console.warn('[useSidebar] getContext failed, context popover will be empty:', e)
    }

    // 文件树预加载：切 session 即拉取，使侧栏「文件」tab 计数（fileCount 读 store.getTree）
    // 立即更新——不依赖用户切到文件 tab 才触发 FileView 的 loadTree。loadTree 内部缓存复用
    // （已加载则 rehydrate 直接返回），FileView 挂载时再调会命中缓存，无重复请求。
    // fire-and-forget：失败不阻断切 session（文件树缺失仅致 tab 数字为 0，切到文件 tab 仍可重试）。
    void useFileTree().loadTree(id)

    // subagent/workflow 列表主动拉取兜底：修复切换 session 后侧栏列表不更新。
    // useSubagentListSync/useWorkflowListSync 的 watch(focusedSessionId) 是异步触发，
    // 与 runtime session.subagents/session.workflowUpdate 广播存在时序竞争（AGENTS.md #7
    // broadcast 早于订阅的历史问题）。这里在 activeId 更新后主动 RPC 拉取，对齐
    // commands/context 的兜底模式。fire-and-forget：失败不阻断切 session（列表缺失
    // 仅致 tab 计数为 0，切到对应 tab 时 sync composable 会再拉一次）。
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    void subagentStore.loadSubagents(id)
    void workflowStore.loadWorkflows(id)

    // [lru-panel-exempt-fix] evictIfNeeded 前刷新所有 panel 绑定 session 的 LRU recency。
    // panel 绑定 session（含 standby 侧）是用户当前可见的活跃 session，刷新其 recency 确保不被误驱逐。
    // 保护随 panel 解绑自然衰减（close/unbind 后不再 touch → 回到正常 LRU 候选）。
    // 不改 isLruExempt（chat.ts:424）：evictSessionWithVirtual 与 evictIfNeeded 共用同一 isExempt，
    // 若加 panel 检查会让 deleteSession 流程中被删 session（必然还绑定 panel）被 exempt 拦截 → 内存泄漏。
    for (const p of panel.panels) {
      if (p.sessionId) chat.touchLru(p.sessionId)
    }
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
      tasks.hydrateFromMessages(sessionId, messages) // 规则 7.5：重开 session 后 goal/todo 快照仍可见
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
   * 新建会话到待机侧（双 panel，panel/spec.md「替换待机侧为新 session 并聚焦」）：
   * 复用 newSession 的 startFlow 流程，但通过 selectSession(panelId) 把新 session 载入非 active panel
   * 并聚焦——active 侧 session 保持不变。单 panel 时回退到载入唯一 panel。首次启动延迟 create 时 no-op。
   */
  async function newSessionToStandby(): Promise<void> {
    if (newTaskInFlight) return
    newTaskInFlight = true
    try {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      const created = flow.currentSession.value
      if (!created) return // 首次启动延迟 create
      // startFlow 已 appendSession + activeId；载入待机 panel 并聚焦
      const standby = panel.panels.find((p) => p.id !== panel.activePanelId)
      await selectSession(created.id, standby ? { panelId: standby.id } : undefined)
    } finally {
      newTaskInFlight = false
    }
  }

  /**
   * 重命名 session（API + 乐观更新 store）。
   * 编排点在 features 层：跨 api + store 的唯一合法层。
   */
  async function renameSession(id: string, label: string): Promise<void> {
    await sessionApi.rename(id, label)
    session.updateLabel(id, label)
  }

  /**
   * 删除 session（API + 从列表移除）。
   * 删除当前 active 时回退到列表首项（若无则停留空态）。
   *
   * [W1 / S3] 跨 store 清理：删除时同步清 fileTree（4 个 per-session Map）+ chat
   * （messages/hydrated/pendingSend 等 8+ ref + timer）+ WS 流式订阅（streamSubscriptions）。
   * 此前注释称「chat store 残留无害」，但频繁建删 session 后内存单调增长且 WS 订阅泄漏。
   *
   * [W1 / S4] 删 active 后 selectSession(next) 失败兜底：removeFromList 已把 activeId
   * 回退到 list[0]，若随后的 selectSession(next) 因网络抖动 reject，activeId=next 但 panel
   * 空载 → 跨 store 撕裂。失败时 fallback 到 navigation.push({ view: 'chat' }) 空态。
   */
  async function deleteSession(id: string): Promise<void> {
    await sessionApi.remove(id)
    const wasActive = session.activeId === id
    // 删除的 session 若承载在某 panel（split 模式下 standby panel 可能 focused 非 activeId），
    // 清空该 panel 绑定，避免 panel 残留指向已删 session 的悬空引用。
    const boundPanel = panel.findPanelBySession(id)
    if (boundPanel) panel.loadSession(boundPanel.id, null)
    // [W3 / W-S6] 清 per-panel viewing 状态：删除 session 前该 panel 可能正停在
    // subagent overlay / agent call overlay，残留 viewing 指向已删 session 的 subagentId /
    // agentCallId，且 streaming 订阅（subagentStore.panelStreamUnsub）泄漏。此处兜底清。
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    if (boundPanel) {
      if (subagentStore.isViewing(boundPanel.id)) {
        // [M7] backToMain 立即清 messages + tombstone（传 mainSessionId/chatEvict）
        const viewingSubId = subagentStore.getViewingSubagentId(boundPanel.id)
        const chatStore = useChatStore()
        subagentStore.backToMain(
          boundPanel.id,
          id,
          viewingSubId ?? undefined,
          (sid) => chatStore.evictVirtualKey(sid),
        )
      }
      if (workflowStore.isViewing(boundPanel.id)) {
        workflowStore.backFromAgentCall(boundPanel.id, (acsId) => useChatStore().evictVirtualKey(acsId), id)
      }
    }
    session.removeFromList(id)
    // 跨 store 清理（S3）：fileTree + tasks + chat store + WS 流式订阅 + 派生状态缓存
    useFileTreeStore().clearSession(id)
    tasks.clearSession(id)
    // [M7 FR-5] evictSessionWithVirtual 在 disposeSession 之前：先按 mainSid 前缀扫 subagent 虚拟 key，
    // 再 dispose 主 session（dispose 后主记录已删，evict 无法反查）。D5 时序。
    const chatStoreForEvict = useChatStore()
    chatStoreForEvict.evictSessionWithVirtual(id)
    // [B8] 主 session 已删，其名下 subagent tombstone（模块级 Set 不随 store 销毁）无意义，
    // 按 mainSid 前缀精确清理，防 Set 随 session 建删单调增长（泄漏）。
    clearSubagentTombstones(id)
    // [M7 D6] agentcall 两段式无 mainSid 前缀，经 workflow 映射清全部 agentcall virtualId
    for (const acsVirtualId of workflowStore.getAgentCallVirtualIdsByMain(id)) {
      chatStoreForEvict.evictVirtualKey(acsVirtualId)
    }
    workflowStore.clearAgentCallMapping(id)
    useChat().disposeSession(id)
    // W3：清除该 session 的 derivedStatus/sessionDigest 缓存，避免已删 session 的 computed 残留
    invalidateStatusCache(id)
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
   * Fork 会话：从指定源 session 截断历史到 fork 点，新建 session（独立 pi 进程）。
   *
   * 语义（问题 6 AI 收尾 fork）：includeFrom=true → 保留到该 assistant（含），
   * openInStandby 打开另一 panel。原 session 不变。
   *
   * 实现：runtime 读源 session JSONL 按 piEntryId 截断 → 新进程 switch_session 加载。
   * 不再前端 hydrate（runtime 通过 switch_session 让 pi 加载截断历史，selectSession 的
   * getHistory 拉真实历史）。fork 需要 Message.piEntryId（文件路径读取时填充），
   * RPC 路径读取的 session 无 piEntryId 时报错提示。
   *
   * srcSessionId 显式传入：Turn 可能在非 active 的 standby panel，fork 源必须是其所在 session。
   */
  async function forkSession(
    srcSessionId: string,
    fromMessageId: string,
    opts?: { includeFrom?: boolean; openInStandby?: boolean },
  ): Promise<string> {
    // 从前端 Message.id 查到 piEntryId（runtime fork 截断定位用）
    const msgs = chat.getMessages(srcSessionId)
    const forkMsg = msgs.find((m) => m.id === fromMessageId)
    if (!forkMsg) {
      throw new Error(`fork: message ${fromMessageId} not found in session ${srcSessionId}`)
    }
    // [HISTORICAL] 2026-07-16：RPC 路径加载的 session 无 piEntryId，传 timestamp + role 让 runtime 读 JSONL 匹配
    const created = await sessionApi.fork(srcSessionId, {
      piEntryId: forkMsg.piEntryId,
      messageTimestamp: forkMsg.timestamp,
      messageRole: forkMsg.role,
      includeFrom: opts?.includeFrom,
    })
    session.appendSession(created)
    // [W2 fast-fork] 后台 fork 不再 split/跳转：去掉 panel.split() + selectSession(standby)。
    // fork 后留在原线，对话流经 session.forkNotice 广播插反馈行（FR-9/10），侧栏静默新增。
    // openInStandby 选项保留为契约（调用方可能传入），但行为退化为「不切焦点」。
    return created.id
  }

  /**
   * Fork-to-Ask（FR-9/10 高频路径）：fork 新 session + 把 content 作为首条 user message 发送。
   *
   * 原子语义：
   * - fork 失败 → 不发送（forkSession 内部抛错自然短路，无占位 session 需回滚）。
   * - send 失败 → 回滚（sessionApi.remove + session.removeFromList）清理占位 session，避免悬挂空壳。
   *
   * 直接调 chatApi.send 而非 useChat().send：后者内部 try/catch 吞掉 send 错误（仅 toast），
   * 此处需要捕获 reject 触发回滚。toast 由此处显式给出（保证用户可见反馈）。
   * 主线 session 全程不参与（不写入、不 streaming、不 split）。
   */
  async function forkSessionAsk(
    srcSessionId: string,
    fromMessageId: string,
    content: string,
  ): Promise<void> {
    // 解析 fork 点：尽量取 piEntryId（精确），取不到则降级传 fromMessageId（runtime 走 JSONL 兜底）。
    // 不像 forkSession 那样在消息缺失时硬抛——fork-ask 的核心有效负载是 content，fork 点缺失不应阻断。
    const forkMsg = chat.getMessages(srcSessionId).find((m) => m.id === fromMessageId)
    const created = await sessionApi.fork(srcSessionId, {
      piEntryId: forkMsg?.piEntryId,
      messageTimestamp: forkMsg?.timestamp,
      messageRole: forkMsg?.role,
      includeFrom: true,
    })
    session.appendSession(created)
    const newId = created.id
    const prompt = segmentsToPrompt(textToSegments(content))
    try {
      await chatApi.send(newId, prompt)
    } catch (e) {
      // send 失败回滚：删除占位 session（runtime + 列表），避免空壳悬挂。
      // 不 rethrow：错误已 toast 化，forkSessionAsk 对调用方表现为「已处理」（resolves undefined）。
      await sessionApi.remove(newId).catch(() => {})
      session.removeFromList(newId)
      const msg = e instanceof Error ? e.message : String(e)
      const { error: toastError } = useToast()
      toastError(t('composable.sendFailed', { msg }))
    }
  }

  /** 进入 Overview：push view:'overview'（ADR-0022，sidebar 持久，main 被覆盖） */
  function goOverview(): void {
    navigation.push({ view: 'overview' })
  }

  /**
   * 加载 session 列表（W6 去全量预 hydrate）。
   * 铁律 1：api 调用只在此 features 层，组件不直接 import api。
   *
   * sessionApi.list() 返 SessionGroup[]（按 cwd 分组，D7），setGroups 填入分组真源。
   * 不再全量预 hydrate 各 session 历史——侧栏 status 由元数据 status（W5 session_end 终态）
   * + 瞬态（W2 streamingSessionIds/compactingSessions Set）派生，用户点开 session 时按需 hydrate
   * （selectSession 路径不变）。消除启动时 N 次 getHistory 全量读 JSONL 的卡顿峰值 + 内存膨胀。
   */
  async function loadSessions(): Promise<void> {
    try {
      const groups = await sessionApi.list()
      session.setGroups(groups)
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
      // 3) 预填 cwd（G1.1「沿用最近 session 目录」做新任务，chip 所见即所得）：
      //    W3: 改接 workspaceStore.defaultCwd（取代从 session.list 派生 resolveDefaultCwd）。
      const recentCwd = workspaceStore.defaultCwd
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
    newSessionToStandby,
    retryHistory,
    goOverview,
    loadSessions,
    initApp,
    onConnected,
    toggleCollapse,
    syncSessionToPanel,
    renameSession,
    deleteSession,
    forkSession,
    forkSessionAsk,
  }
}
