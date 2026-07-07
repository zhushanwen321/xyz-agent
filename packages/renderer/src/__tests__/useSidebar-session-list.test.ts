/**
 * useSidebar session.list 订阅单测（#7 方案 A；CLAUDE.md 规则 #2 防重复注册）。
 *
 * 覆盖：
 * - session.list 广播 → session store setGroups 更新列表（不重载历史）
 * - 多实例 refCount 去重：N 次 useSidebar() 只注册 1 个 handler，一次广播只触发 1 次 setGroups
 * - 全部 effect scope 释放后监听取消（onScopeDispose 收尾），广播不再更新
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/useSidebar-session-list.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary } from '@xyz-agent/shared'

// features 层调用 api 域；本测试只验订阅链路，把 api 域全 mock 成 no-op（订阅走真实的 @/api/events）。
vi.mock('@/api', () => ({
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
  },
}))

import * as events from '@/api/events'
import { useSidebar } from '@/composables/features/useSidebar'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

function makeGroups(): SessionGroup[] {
  return [{ cwd: '/proj', sessions: [makeSummary('s1')] }]
}

/** 模拟 runtime broadcastSessionList：广播一条 session.list ServerMessage */
function broadcastSessionList(groups: SessionGroup[]): void {
  events.dispatchGlobal({ type: 'session.list', payload: { groups } })
}

it('session.list 广播经 useSidebar 订阅更新 session store', () => {
  const scope = effectScope()
  scope.run(() => useSidebar())
  const store = useSessionStore()
  expect(store.groups).toEqual([])

  broadcastSessionList(makeGroups())
  expect(store.groups).toEqual(makeGroups())

  scope.stop()
})

it('多实例 refCount 去重：N 次 useSidebar() 一次广播只触发 1 次 setGroups', () => {
  const store = useSessionStore()
  // 必须在首个 useSidebar() 注册前 spy：bindSessionListBroadcast 在注册时捕获 setGroups 引用
  const setGroupsSpy = vi.spyOn(store, 'setGroups')

  const a = effectScope()
  const b = effectScope()
  const c = effectScope()
  a.run(() => useSidebar())
  b.run(() => useSidebar())
  c.run(() => useSidebar())

  setGroupsSpy.mockClear() // 清注册期残留（实际为 0，防御）
  broadcastSessionList(makeGroups())
  // refCount 保证只注册 1 个 handler；若去重失效，此处为 3
  expect(setGroupsSpy).toHaveBeenCalledTimes(1)

  a.stop()
  b.stop()
  c.stop()
})

it('全部 scope 释放后监听取消：广播不再更新 store', () => {
  const scope = effectScope()
  scope.run(() => useSidebar())
  const store = useSessionStore()
  // 先填入一组数据，释放后广播应保持不变
  store.setGroups(makeGroups())
  const before = store.groups

  scope.stop() // onScopeDispose → refCount 1→0 → 取消监听
  broadcastSessionList([{ cwd: '/other', sessions: [makeSummary('x')] }])

  expect(store.groups).toEqual(before) // 未变 = 监听已取消
})
