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
 * derivedStatus（D6）：session 5 态前端派生。本层能同时读 chat store 的消息分区 +
 * session store，是派生逻辑的正确落点（stores 互不 import，派生无法放在 store 内）。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { chat as chatApi, session as sessionApi } from '@/api'
import { useChatStore } from '@/stores/chat'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import type { DerivedStatus } from '@/types'

/**
 * 派生信号 → DerivedStatus 映射依据（D6，spec §5 D6 + §会话项）。
 * - toolCall.status 'running' → waiting（tool 执行中/待审批，agent 暂停）
 * - isStreaming 或 Message.status 'streaming' → running（文本流式）
 * - Message.status 'error' → error
 * - Message.isInterrupted → stopped（用户 abort / 进程退出）
 */
const ERROR_STATUS = 'error'
const STREAMING_STATUS = 'streaming'
const TOOL_RUNNING = 'running'

/**
 * 派生 session 5 态（D6）。
 * 优先级：waiting > running > error > stopped > done。
 * waiting 优先于 running：turn 活跃期 tool 执行属 waiting（无文本流），spec 区分二者。
 * 空消息（无回合）→ done。
 *
 * TODO 联调：waiting 真实信号待 pi tool_call_start/end 事件细化（待审 vs 执行中）；
 *       stopped 真实信号待 abort/exit 事件。当前从 message 字段派生，mock 已可验收。
 */
export function deriveStatus(
  sessionId: string,
  chat: ReturnType<typeof useChatStore>,
  isStreaming: boolean,
): DerivedStatus {
  const msgs = chat.getMessages(sessionId)
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    const tools = last.toolCalls ?? []
    if (tools.length > 0 && tools[tools.length - 1].status === TOOL_RUNNING) {
      return 'waiting'
    }
  }
  if (isStreaming || last?.status === STREAMING_STATUS) return 'running'
  if (!last) return 'done'
  if (last.status === ERROR_STATUS) return 'error'
  if (last.role === 'assistant' && last.isInterrupted) return 'stopped'
  return 'done'
}

export function useSidebar() {
  const navigation = useNavigationStore()
  const session = useSessionStore()
  const chat = useChatStore()
  const sidebar = useSidebarStore()
  const panel = usePanelStore()

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
   */
  async function selectSession(id: string): Promise<void> {
    await sessionApi.switchSession(id)
    session.activeId = id
    syncSessionToPanel(id)
    navigation.push({ view: 'chat', sessionId: id })
    // 历史回填：features 层跨 api+stores，是 hydrate 的正确编排点
    if (!chat.isHydrated(id)) {
      const history = await chatApi.getHistory(id)
      chat.hydrate(id, history)
    }
  }

  /**
   * 新建 session：create api → 加入 session.list → select。
   * 返回新 session id 供调用方（如 ⌘N）使用。
   */
  async function newSession(): Promise<string> {
    const created = await sessionApi.create()
    session.list = [...session.list, created]
    await selectSession(created.id)
    return created.id
  }

  /** 进入 Overview：push view:'overview'（ADR-0022，sidebar 持久，main 被覆盖） */
  function goOverview(): void {
    navigation.push({ view: 'overview' })
  }

  /**
   * 加载 session 列表（mock 优先，让 fixture 可见）。
   * 铁律 1：api 调用只在此 features 层，组件不直接 import api。
   *
   * 同时预 hydrate 各 session 的 chat 历史，让 sidebar 状态点（D6）载入即可派生——
   * 否则未访问的 session 在 chat store 为空，deriveStatus 全返回 done，5 态无法可见。
   * isHydrated 守卫幂等，selectSession 的按需 hydrate 命中后变 no-op，不会重复载入。
   * TODO 联调：真实 runtime 下全量预载历史有成本，应改为 WS 推送 status 或默认 done/idle + 按需 hydrate。
   */
  async function loadSessions(): Promise<void> {
    const list = await sessionApi.list()
    session.list = list
    await Promise.allSettled(
      list.map(async (s) => {
        if (!chat.isHydrated(s.id)) {
          chat.hydrate(s.id, await chatApi.getHistory(s.id))
        }
      }),
    )
  }

  /** 切换折叠态（C）。展开/折叠 toggle，spec §收起态。 */
  function toggleCollapse(): void {
    sidebar.collapsed = !sidebar.collapsed
  }

  /**
   * 响应式派生指定 session 的状态点（D6）。
   * 读 chat store 分区末尾消息 + 全局 isStreaming（当前活跃 session 的流式态）。
   */
  function derivedStatus(id: string): ComputedRef<DerivedStatus> {
    return computed(() => {
      const isActiveStreaming = chat.isStreaming && session.activeId === id
      return deriveStatus(id, chat, isActiveStreaming)
    })
  }

  /**
   * 响应式派生指定 session 的鸟瞰摘要（Overview 卡片用）。
   * - summary：末条 assistant 文本（content），无则空串（卡片不渲染摘要区）
   * - turnCount：user 消息数（回合 = user + 其后 assistant 序列）
   * 文件改动数无 mock 数据源（runtime file-changes 未联调），不臆造，卡片隐藏该指标。
   */
  function sessionDigest(id: string): ComputedRef<{ summary: string; turnCount: number }> {
    return computed(() => {
      const msgs = chat.getMessages(id)
      let lastAssistant = ''
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i].role === 'assistant') {
          lastAssistant = msgs[i].content
          break
        }
      }
      const turnCount = msgs.filter((m) => m.role === 'user').length
      return { summary: lastAssistant, turnCount }
    })
  }

  return {
    selectSession,
    newSession,
    goOverview,
    loadSessions,
    toggleCollapse,
    syncSessionToPanel,
    derivedStatus,
    sessionDigest,
  }
}
