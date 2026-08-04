/**
 * useSidebar config.sessions 订阅单测（#7 方案 A；CLAUDE.md 规则 #2 防重复注册）。
 *
 * 覆盖：
 * - config.sessions 广播 → session store setGroups 更新列表（不重载历史）
 * - 多实例 refCount 去重：N 次 useSidebarNew() 只注册 1 个 handler，一次广播只触发 1 次 setGroups
 * - 全部 effect scope 释放后监听取消（onScopeDispose 收尾），广播不再更新
 *
 * 注：WS 消息类型原为 session.list，PR #87 D1 重构重命名为 config.sessions（useSidebar 同步订阅 config.sessions）。
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
import { useSidebarNew } from '@/composables/features/useSidebarNew'

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

/** 模拟 runtime broadcastSessionList：广播一条 config.sessions ServerMessage（PR #87 D1：session.list → config.sessions 重命名） */
function broadcastSessionList(groups: SessionGroup[]): void {
  events.dispatchGlobal({ type: 'config.sessions', payload: { groups } })
}

it('config.sessions 广播经 useSidebar 订阅更新 session store', () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebarNew())!
  // 接缝本地 raw store（C-W5-5：useSidebarNew 内部 createSessionStore 实例）
  expect(sidebar.__testStore.groups.value).toEqual([])

  broadcastSessionList(makeGroups())
  expect(sidebar.__testStore.groups.value).toEqual(makeGroups())

  scope.stop()
})

it('多实例 refCount 去重：N 次 useSidebarNew() 一次广播只触发 1 次 setGroups', () => {
  // 去重的可观测行为：refCount 保证 handler 只绑定首个实例的 store，广播只更新它，
  // 其余实例的接缝本地 store 保持初始空态（若去重失效，3 个实例的 store 都会被更新）。
  // 注：不 spy setGroups——core bindSessionListBroadcast 捕获的是注册时刻的函数引用，
  // 注册后 vi.spyOn(store,'setGroups') 替换属性对已捕获引用无效（raw store 非 pinia proxy）。
  const a = effectScope()
  const sidebarA = a.run(() => useSidebarNew())!
  const b = effectScope()
  const c = effectScope()
  const sidebarB = b.run(() => useSidebarNew())!
  const sidebarC = c.run(() => useSidebarNew())!

  broadcastSessionList(makeGroups())
  // 首个实例 store 收到广播；B/C 未被更新 = 只注册了 1 个 handler
  expect(sidebarA.__testStore.groups.value).toEqual(makeGroups())
  expect(sidebarB.__testStore.groups.value).toEqual([])
  expect(sidebarC.__testStore.groups.value).toEqual([])

  a.stop()
  b.stop()
  c.stop()
})

it('全部 scope 释放后监听取消：广播不再更新 store', () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebarNew())!
  // 先填入一组数据，释放后广播应保持不变
  sidebar.__testStore.setGroups(makeGroups())
  const before = sidebar.__testStore.groups.value

  scope.stop() // onScopeDispose → refCount 1→0 → 取消监听
  broadcastSessionList([{ cwd: '/other', sessions: [makeSummary('x')] }])

  expect(sidebar.__testStore.groups.value).toEqual(before) // 未变 = 监听已取消
})
