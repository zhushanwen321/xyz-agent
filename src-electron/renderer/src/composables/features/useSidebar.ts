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
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import type { DerivedStatus } from '@/types'

/** chat store 最后一条消息的 status 字段 → DerivedStatus 映射依据 */
const ERROR_STATUS = 'error'
const STREAMING_STATUS = 'streaming'

/**
 * 派生 session 5 态（D6）。
 * 优先级：isStreaming(running) > error > streaming(running) > done。
 * 空消息（无回合）→ done。waiting（tool 待审脉冲）等联调阶段补，v1 暂不派生。
 */
export function deriveStatus(
  sessionId: string,
  chat: ReturnType<typeof useChatStore>,
  isStreaming: boolean,
): DerivedStatus {
  if (isStreaming) return 'running'
  const msgs = chat.getMessages(sessionId)
  const last = msgs[msgs.length - 1]
  if (!last) return 'done'
  if (last.status === ERROR_STATUS) return 'error'
  if (last.status === STREAMING_STATUS) return 'running'
  return 'done'
}

export function useSidebar() {
  const navigation = useNavigationStore()
  const session = useSessionStore()
  const chat = useChatStore()
  const sidebar = useSidebarStore()

  /**
   * 选择 session：push 导航栈（view:chat + sessionId）+ switchSession api + 更新 activeId。
   * 首次进入该 session 时拉取历史注入 chat store（UC-2 切换可见块类型，G2-006）。
   * switchSession 失败（mock id 不存在）抛错，UI 层捕获；不更新 activeId。
   */
  async function selectSession(id: string): Promise<void> {
    await sessionApi.switchSession(id)
    session.activeId = id
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
   */
  async function loadSessions(): Promise<void> {
    session.list = await sessionApi.list()
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
    derivedStatus,
    sessionDigest,
  }
}
