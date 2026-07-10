/**
 * session.renamed 事件 → store label 同步测试（CLAUDE.md 规则 #7 Session 隔离）。
 *
 * 锁定：pi 改写 session 名（session_info_changed）经 runtime event-adapter 映射为
 * session.renamed 推送（payload { sessionId, name }）。useChat.ensureStreamSubscription
 * 的 switch 须消费此事件，调 sessionStore.updateLabel 同步，否则 pi 改名后前端侧栏不更新。
 *
 * 事故背景：tui-to-gui-mapping-audit.md:62 标记 session_info_changed 未处理，
 * useChat 的 switch 落到 default:break 丢弃。本次补 case 消费。
 *
 * 覆盖：
 * - 正常 session.renamed（含 sessionId+name）→ store 对应 session label 更新
 * - payload.name 为空 → 跳过（防 pi 推空名覆盖用户手动 rename 的值）
 * - payload.name 为 undefined → 跳过
 *
 * mock 策略：vi.hoisted + vi.mock('@/api')（chat.streamSubscribe 捕获回调，手动触发），
 * 真用 useSessionStore（验证 updateLabel 落点）+ useChat（被测入口）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/session-renamed-sync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

type StreamCb = (msg: { type: string; payload: Record<string, unknown> }) => void

// vi.mock factory 是 hoisted 的，不能引用外部变量；用 vi.hoisted 提升共享状态
const { streamCbHolder, streamSubscribeMock } = vi.hoisted(() => ({
  streamCbHolder: { current: null as StreamCb | null },
  streamSubscribeMock: vi.fn((_sid: string, cb: StreamCb) => {
    streamCbHolder.current = cb
    return () => {
      streamCbHolder.current = null
    }
  }),
}))

vi.mock('@/api', () => ({
  chat: { send: vi.fn(), streamSubscribe: streamSubscribeMock },
}))

import { useChat } from '@/composables/features/useChat'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  streamCbHolder.current = null
  streamSubscribeMock.mockClear()
})

/** 往 session store 填一个 session（按 cwd 归组） */
function seedSession(s: SessionSummary): void {
  const store = useSessionStore()
  const group: SessionGroup = { cwd: s.cwd, sessions: [s] }
  store.setGroups([group])
}

describe('session.renamed 事件 → store label 同步', () => {
  it('正常 session.renamed（sessionId+name）→ store 对应 session label 更新', async () => {
    seedSession({
      id: 's1',
      label: '旧名字',
      cwd: '/repo',
      status: 'idle',
      lastActiveAt: 100,
      modelId: 'm',
      tokenCount: 0,
    })
    const chat = useChat()
    // send 触发 ensureStreamSubscription，注册回调（mock 捕获）
    await chat.send('s1', '触发订阅')
    expect(streamCbHolder.current).not.toBeNull()

    // 模拟 runtime 推送 session.renamed
    streamCbHolder.current!({ type: 'session.renamed', payload: { sessionId: 's1', name: 'pi 生成的新名字' } })

    const updated = useSessionStore().list.find((s) => s.id === 's1')
    expect(updated?.label).toBe('pi 生成的新名字')
  })

  it('payload.name 为空字符串 → 跳过，label 不被覆盖（防 pi 推空名覆盖用户 rename）', async () => {
    seedSession({
      id: 's2',
      label: '用户手动起的名',
      cwd: '/repo',
      status: 'idle',
      lastActiveAt: 100,
      modelId: 'm',
      tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('s2', '触发订阅')

    streamCbHolder.current!({ type: 'session.renamed', payload: { sessionId: 's2', name: '' } })

    const updated = useSessionStore().list.find((s) => s.id === 's2')
    expect(updated?.label).toBe('用户手动起的名') // 保持原值，未被空名覆盖
  })

  it('payload.name 为 undefined → 跳过', async () => {
    seedSession({
      id: 's3',
      label: '原名',
      cwd: '/repo',
      status: 'idle',
      lastActiveAt: 100,
      modelId: 'm',
      tokenCount: 0,
    })
    const chat = useChat()
    await chat.send('s3', '触发订阅')

    // event-adapter 对 event.name 为 undefined 时 payload.name 也为 undefined
    streamCbHolder.current!({ type: 'session.renamed', payload: { sessionId: 's3' } })

    const updated = useSessionStore().list.find((s) => s.id === 's3')
    expect(updated?.label).toBe('原名')
  })
})
