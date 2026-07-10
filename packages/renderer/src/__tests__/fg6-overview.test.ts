/**
 * FG6 自检 —— Overview 进入/退出语义 + sessionDigest 派生 + formatTime 纯函数。
 *
 * 覆盖 spec §8.5 v1 必做项：
 * - Overview 进入（nav.push view:'overview'）
 * - 基本退出（back 回 chat view；canBack 守卫：栈空 no-op）
 * - 点卡片载入 session（selectSession → push chat + activeId）
 * - sessionDigest：末条 assistant 文本 + 回合计数（空 session 摘要为空）
 * - formatRelativeTime 四个分桶（今天/昨天/7 天内/更早）
 *
 * useSidebar 走 @/api 门面，测试用 vi.mock 替换为 mock 实现（避免 transport 挂起）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/fg6-overview.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as mockApi from '@/api/mock'
import { useChatStore } from '@/stores/chat'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/useSidebar'
import { useSessionDerivations } from '@/composables/features/useSessionDerivations'
import { formatRelativeTime } from '@/composables/logic/formatTime'

/** useSidebar 经 @/api 门面调真实 transport 会挂起；测试统一替成 mock 实现。
 *  selectSession 触发 loadTree（文件树预加载，并行拉 file.tree + git.status），补 file/git domain mock 避免 unhandled rejection。 */
vi.mock('@/api', () => ({
  session: mockApi.session,
  chat: mockApi.chat,
  file: mockApi.file,
  git: mockApi.git,
}))

const HOUR = 3_600_000
const DAY = 86_400_000

describe('FG6 Overview 进入/退出 + sessionDigest', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Overview 进入：goOverview push view:overview，current.view 切换', () => {
    const navigation = useNavigationStore()
    const { goOverview } = useSidebar()
    expect(navigation.current.view).toBe('chat')
    goOverview()
    expect(navigation.current.view).toBe('overview')
  })

  it('基本退出：back 回上一个 chat view', () => {
    const navigation = useNavigationStore()
    const { goOverview } = useSidebar()
    navigation.push({ view: 'chat', sessionId: 's1' })
    goOverview()
    expect(navigation.current.view).toBe('overview')
    expect(navigation.canBack).toBe(true)
    navigation.back()
    expect(navigation.current.view).toBe('chat')
    expect(navigation.current.sessionId).toBe('s1')
  })

  it('canBack 守卫：栈空时 back 不越界（仍停在 overview）', () => {
    const navigation = useNavigationStore()
    const { goOverview } = useSidebar()
    goOverview()
    expect(navigation.canBack).toBe(false)
    navigation.back() // 栈空 no-op
    expect(navigation.current.view).toBe('overview')
  })

  it('点卡片载入 session：selectSession push chat + 更新 activeId + focusedSessionId', async () => {
    const navigation = useNavigationStore()
    const session = useSessionStore()
    const { selectSession, focusedSessionId } = useSidebar()
    await selectSession('s1')
    expect(navigation.current.view).toBe('chat')
    expect(navigation.current.sessionId).toBe('s1')
    expect(session.activeId).toBe('s1')
    // Overview.vue 卡片高亮 SSOT = focusedSessionId（从 panel.activePanelId 派生）。
    // selectSession → syncSessionToPanel → loadSession(activePanel, 's1') → focusedSessionId 跟随。
    expect(focusedSessionId.value).toBe('s1')
  }, 10_000)

  /**
   * S16：split panel 切焦点时 Overview 卡片高亮跟随 focusedSessionId（非 session.activeId）。
   * focusedSessionId = panel.activePanelId 绑定的 session；session.activeId 是导航/启动语义，
   * 与高亮解耦（useSidebar §focusedSessionId 注释）。双 panel 各载不同 session 后切 active panel，
   * focusedSessionId 应切到目标 panel 的 session，即使 activeId 不变。
   */
  it('S16 split panel 切焦点 → focusedSessionId 跟随 active panel（与 activeId 解耦）', async () => {
    const panel = usePanelStore()
    const { focusedSessionId } = useSidebar()
    // 单 panel 默认载 s1（focusedSessionId=s1）
    panel.loadSession(panel.activePanelId, 's1')
    expect(focusedSessionId.value).toBe('s1')
    // split 成双 panel，右 panel 载 s2，并把 active 焦点切到右 panel
    panel.split()
    const [left, right] = panel.panels
    panel.loadSession(right.id, 's2')
    panel.setActive(right.id)
    // active panel=right → focusedSessionId=s2（Overview 右侧卡片高亮）
    expect(focusedSessionId.value).toBe('s2')
    // 切回 left panel 焦点 → focusedSessionId=s1
    panel.setActive(left.id)
    expect(focusedSessionId.value).toBe('s1')
  })

  it('sessionDigest：s1 fixture 末条 assistant 摘要 + 回合计数', async () => {
    const { selectSession } = useSidebar()
    const { sessionDigest } = useSessionDerivations()
    await selectSession('s1')
    const digest = sessionDigest('s1').value
    // fixture s1 有 2 个 user 回合，末条 assistant 为「提交时遇到文件锁…」
    expect(digest.turnCount).toBe(2)
    expect(digest.summary).toContain('文件锁')
  }, 10_000)

  it('sessionDigest：空 session（s3）摘要为空、回合 0', () => {
    const chat = useChatStore()
    const { sessionDigest } = useSessionDerivations()
    chat.hydrate('s3', [])
    const digest = sessionDigest('s3').value
    expect(digest.summary).toBe('')
    expect(digest.turnCount).toBe(0)
  })
})

describe('formatRelativeTime 四分桶', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T14:30:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('今天 → HH:MM', () => {
    const now = Date.now()
    expect(formatRelativeTime(now)).toMatch(/^\d{2}:\d{2}$/)
    expect(formatRelativeTime(now - 2 * HOUR)).toMatch(/^\d{2}:\d{2}$/)
  })

  it('昨天 → 「昨天」', () => {
    expect(formatRelativeTime(Date.now() - DAY - HOUR)).toBe('昨天')
  })

  it('7 天内 → 「N 天前」', () => {
    expect(formatRelativeTime(Date.now() - 3 * DAY)).toBe('3 天前')
  })

  it('更早 → 「M 月 D 日」', () => {
    const ts = new Date('2026-05-01T10:00:00Z').getTime()
    expect(formatRelativeTime(ts)).toMatch(/月.*日$/)
  })
})
