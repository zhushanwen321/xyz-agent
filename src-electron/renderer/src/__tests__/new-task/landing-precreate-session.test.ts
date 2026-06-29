/**
 * Wave 2 单测：Landing 选定目录后预创建 session（不再延迟 create）。
 *
 * 根因：CommandPopover 在 sid=null 时不订阅，无命令源。原「延迟 create」设计下
 * landing 态 currentSessionId 恒 null，故 slash 浮层在 landing 不可用。
 * 修复：选目录（selectWorkspace/openDirDialog）即 create session 并绑定 currentSession，
 *       CommandPopover 经 sessionId 拿到真实命令。submitFirstMessage 复用已建 session。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/landing-precreate-session.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

const apiMock = vi.hoisted(() => ({
  create: vi.fn((cwd?: string): Promise<SessionSummary> => Promise.resolve({
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    label: '新会话',
    cwd: cwd ?? '/repo',
    status: 'idle',
    lastActiveAt: Date.now(),
    modelId: 'm',
    tokenCount: 0,
  })),
  remove: vi.fn((): Promise<void> => Promise.resolve()),
  getCommands: vi.fn((): Promise<{ sessionId: string; commands: Array<{ name: string; source: string }> }> =>
    Promise.resolve({ sessionId: 'x', commands: [{ name: '/commit', source: 'extension' }] }),
  ),
}))

vi.mock('@/api', () => ({
  session: { create: apiMock.create, remove: apiMock.remove, getCommands: apiMock.getCommands },
  git: {},
}))

// mock useChat.send（submitFirstMessage 会调，本测试只验 create 不重复）
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ send: vi.fn(() => Promise.resolve()), steer: vi.fn(), followUp: vi.fn(), abort: vi.fn(), compact: vi.fn() }),
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
})

/** dir-popover 态选目录（真实路径：startFlow→landing→openDirPopover→selectWorkspace） */
async function pickDir(flow: ReturnType<typeof useNewTaskFlow>, cwd: string): Promise<void> {
  flow.openDirPopover()
  await flow.selectWorkspace(cwd)
}

it('U4: selectWorkspace 选目录后预创建 session，currentSessionId 非 null', async () => {
  const flow = useNewTaskFlow()
  await flow.startFlow()
  expect(flow.currentSessionId.value).toBeNull()

  await pickDir(flow, '/my-project')

  expect(apiMock.create).toHaveBeenCalledWith('/my-project')
  expect(flow.currentSessionId.value).not.toBeNull()
  expect(flow.currentCwd.value).toBe('/my-project')
})

it('U4b: selectWorkspace 重选不同目录 → 删旧 session 建新（不留空 session）', async () => {
  const flow = useNewTaskFlow()
  await flow.startFlow()
  await pickDir(flow, '/repo-a')
  const firstSid = flow.currentSessionId.value
  expect(firstSid).not.toBeNull()

  await pickDir(flow, '/repo-b')

  // 旧 session 被删（landing 态未 send 的空 session 删除安全）
  expect(apiMock.remove).toHaveBeenCalledWith(firstSid)
  // 新 session 已建
  expect(apiMock.create).toHaveBeenCalledWith('/repo-b')
  expect(flow.currentSessionId.value).not.toBe(firstSid)
  expect(flow.currentCwd.value).toBe('/repo-b')
})

it('U4c: selectWorkspace 选同目录 → noop（不重复建删）', async () => {
  const flow = useNewTaskFlow()
  await flow.startFlow()
  await pickDir(flow, '/repo')
  expect(apiMock.create).toHaveBeenCalledTimes(1)

  await pickDir(flow, '/repo') // 同目录

  expect(apiMock.create).toHaveBeenCalledTimes(1) // 不重复建
  expect(apiMock.remove).not.toHaveBeenCalled()
})

it('U5: submitFirstMessage 复用已建 session，不重复 create', async () => {
  const flow = useNewTaskFlow()
  await flow.startFlow()
  await pickDir(flow, '/repo') // 预创建
  expect(apiMock.create).toHaveBeenCalledTimes(1)

  // submitFirstMessage 不应再调 create（复用预建的）
  await flow.submitFirstMessage('hello')

  expect(apiMock.create).toHaveBeenCalledTimes(1)
})
