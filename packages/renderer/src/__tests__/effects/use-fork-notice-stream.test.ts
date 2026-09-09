/**
 * useForkNoticeStream 单测（feed 消费 + 交互契约）。
 *
 * [D6 死路径清理 2026-09-09] 原 W2TC10/W2TC11 定位断言（injectedBaseTop 短路 /
 * vlistBottom 基线 / 占位叠加 / forkNoticeTop 堆叠）随 absolute 定位链整体删除——
 * ForkNotice 为文档流 block（tailEl 容器内），定位由文档序自然堆叠，无计算面可测。
 * 本文件改测剩余职责：feed 按 sessionId 过滤 + onView/onDismiss 交互委托。
 *
 * mock 策略：mock useForkNoticeFeed（notices 返回可配置列表，dismissNotice vi.fn）+
 * useSidebar（selectSession vi.fn）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-fork-notice-stream.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useForkNoticeStream } from '@/composables/panel/useForkNoticeStream'
import type { ForkNoticeEntry } from '@/composables/effects/useForkNoticeEffect'

// mock useForkNoticeFeed：notices 返回可配置列表（按 sessionId 过滤的消费面在此之上），
// dismissNotice vi.fn 供 onDismiss 委托断言。
const dismissNotice = vi.fn()
const feedNotices = vi.fn<(sid: string) => ForkNoticeEntry[]>()
vi.mock('@/composables/effects/useForkNoticeEffect', () => ({
  useForkNoticeFeed: () => ({
    notices: (sid: string) => feedNotices(sid),
    dismissNotice: (...args: unknown[]) => dismissNotice(...(args as [string, number])),
  }),
}))

// mock useSidebar：selectSession 不做真实跳转
const selectSession = vi.fn()
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: (...args: unknown[]) => selectSession(...(args as [string])) }),
}))

/** ForkNoticeEntry 测试造数（字段集对齐 useForkNoticeEffect 的条目形状） */
function makeEntry(id: number): ForkNoticeEntry {
  return {
    id,
    branchName: `branch-${id}`,
    preview: `preview-${id}`,
    kind: 'forked',
    newSessionId: `s-child-${id}`,
    createdAt: 0,
  } as ForkNoticeEntry
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  feedNotices.mockReturnValue([])
})

/** mount useForkNoticeStream（effectScope 包裹）。sessionId getter 返回固定字符串。 */
function setup(sessionId = 's-fork-test') {
  const scope = effectScope()
  let ret: ReturnType<typeof useForkNoticeStream> | undefined
  scope.run(() => {
    ret = useForkNoticeStream(() => sessionId)
  })
  return { ret: ret! }
}

describe('useForkNoticeStream · forkNotices 按 sessionId 过滤消费', () => {
  it('notices(sessionId) 被 feed 以当前 session id 调用，返回值透传', () => {
    const entries = [makeEntry(1), makeEntry(2)]
    feedNotices.mockReturnValue(entries)

    const { ret } = setup('s-a')
    expect(ret.forkNotices.value).toEqual(entries) // 读取触发 computed 求值

    expect(feedNotices).toHaveBeenCalledWith('s-a')
  })

  it('过滤键 = 容器传入的 sessionId getter（不同实例各自以自身键查询 feed）', () => {
    const { ret } = setup('s-a')
    expect(ret.forkNotices.value).toEqual([]) // 触发 s-a 求值
    expect(feedNotices).toHaveBeenCalledWith('s-a')

    const other = setup('s-b')
    expect(other.ret.forkNotices.value).toEqual([]) // 触发 s-b 求值
    expect(feedNotices).toHaveBeenLastCalledWith('s-b')
  })
})

describe('useForkNoticeStream · 交互委托', () => {
  it('onView(newSessionId) → selectSession 载入分支 session', () => {
    const { ret } = setup()

    ret.onView('s-child-9')

    expect(selectSession).toHaveBeenCalledTimes(1)
    expect(selectSession).toHaveBeenCalledWith('s-child-9')
  })

  it('onDismiss(noticeId) → dismissNotice 以 (sessionId, noticeId) 委托', () => {
    const { ret } = setup('s-x')

    ret.onDismiss(42)

    expect(dismissNotice).toHaveBeenCalledTimes(1)
    expect(dismissNotice).toHaveBeenCalledWith('s-x', 42)
  })
})
