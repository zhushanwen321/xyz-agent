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
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/fg6-overview.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as mockApi from '@/api/mock'
import { useChatStore } from '@/stores/chat'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/useSidebar'
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

  it('点卡片载入 session：selectSession push chat + 更新 activeId', async () => {
    const navigation = useNavigationStore()
    const session = useSessionStore()
    const { selectSession } = useSidebar()
    await selectSession('s1')
    expect(navigation.current.view).toBe('chat')
    expect(navigation.current.sessionId).toBe('s1')
    expect(session.activeId).toBe('s1')
  }, 10_000)

  it('sessionDigest：s1 fixture 末条 assistant 摘要 + 回合计数', async () => {
    const { selectSession, sessionDigest } = useSidebar()
    await selectSession('s1')
    const digest = sessionDigest('s1').value
    // fixture s1 有 2 个 user 回合，末条 assistant 为「提交时遇到文件锁…」
    expect(digest.turnCount).toBe(2)
    expect(digest.summary).toContain('文件锁')
  }, 10_000)

  it('sessionDigest：空 session（s3）摘要为空、回合 0', () => {
    const chat = useChatStore()
    const { sessionDigest } = useSidebar()
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
