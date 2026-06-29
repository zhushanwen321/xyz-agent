/**
 * Wave 1 单测：selectSession 切 session 后主动拉 commands 并本地投递。
 *
 * 根因：runtime broadcast session.commands 发生在 renderer 订阅建立之前 → 丢失。
 * 修复：useSidebar.selectSession 在 switchSession resolve 后主动调 sessionApi.getCommands，
 *       拿到命令后 events.dispatchSession 本地投递，让 CommandPopover 订阅收到。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/useSidebar-get-commands.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { ServerMessage, SessionGroup, SessionSummary } from '@xyz-agent/shared'
import * as events from '@/api/events'

// mock sessionApi：factory 内不能引用外部变量（hoisted），直接 inline；getCommands 用 spy 断言
vi.mock('@/api', () => ({
  session: {
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    getCommands: vi.fn(() => Promise.resolve({
      sessionId: 's1',
      commands: [
        { name: '/commit', description: '提交', source: 'extension' },
        { name: 'skill:code-review', description: '审查', source: 'skill' },
      ],
    })),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    create: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 })),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
  },
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
}))

import { session as sessionMock } from '@/api'

import { useSidebar } from '@/composables/features/useSidebar'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

function makeGroups(ids: string[]): SessionGroup[] {
  return [{ cwd: '/proj', sessions: ids.map(makeSummary) }]
}

it('U1: selectSession 调 switchSession 后调 sessionApi.getCommands 拉命令', async () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebar())!
  // 喂一个 session 列表让 activeId 可设
  events.dispatchGlobal({ type: 'session.list', payload: { groups: makeGroups(['s1']) } })

  await sidebar.selectSession('s1')

  expect(sessionMock.switchSession).toHaveBeenCalledWith('s1')
  // 关键断言：getCommands 被调，参数是切到的 sessionId
  expect(sessionMock.getCommands).toHaveBeenCalledWith('s1')
  scope.stop()
})

it('U2: getCommands 拉到命令后 events.dispatchSession 本地投递 session.commands', async () => {
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebar())!
  events.dispatchGlobal({ type: 'session.list', payload: { groups: makeGroups(['s1']) } })

  // 订阅 s1 session 通道，捕获投递的消息
  const received: ServerMessage[] = []
  events.on('s1', (msg) => received.push(msg))

  await sidebar.selectSession('s1')

  // 命令消息已投递到 s1 通道
  const cmdMsgs = received.filter((m) => m.type === 'session.commands')
  const withCommands = cmdMsgs.find((m) => (m.payload as { commands?: unknown[] }).commands)
  expect(withCommands).toBeDefined()
  expect((withCommands!.payload as { commands: unknown[] }).commands).toHaveLength(2)
  scope.stop()
})

it('U3: getCommands 失败不阻断 selectSession（命令缺失不致命，可后补）', async () => {
  sessionMock.getCommands.mockRejectedValueOnce(new Error('pi not ready'))
  const scope = effectScope()
  const sidebar = scope.run(() => useSidebar())!
  events.dispatchGlobal({ type: 'session.list', payload: { groups: makeGroups(['s1']) } })

  // 不应抛
  await expect(sidebar.selectSession('s1')).resolves.toBeUndefined()
  scope.stop()
})
