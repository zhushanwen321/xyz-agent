/**
 * lru-panel-exempt-fix 红灯测试：方案 C — composable 层 evictIfNeeded 前刷新 panel 绑定 session 的 LRU recency。
 *
 * 锁定的 AC：
 * - AC-1：双 panel 下 standby 绑定 sessionY，active 侧切 9 个其他 session 后，sessionY 仍在 messages map 中
 * - AC-2：单 panel 下切 9 个 session，最旧的 session 被驱逐（LRU 基线不退化）
 * - AC-4：panel close 后旧 session 不再被保护，切足够 session 后可被驱逐
 *
 * [红灯说明] selectSession 当前未在 evictIfNeeded 前刷新 panel 绑定 session 的 recency，
 * AC-1/AC-4 用例应因修复缺失而 fail（standby session 被误驱逐）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useSidebar-lru-panel-exempt.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { Message, SessionGroup, SessionSummary } from '@xyz-agent/shared'
import { _resetLruForTest } from '@/stores/chat-lru'

// ── mock 无关 store / composable，减少 selectSession 噪音 ──
const clearSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ clearSession: clearSessionMock }),
}))

const useChatDisposeMock = vi.hoisted(() => vi.fn())
const setHistoryTruncatedMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({
    disposeSession: useChatDisposeMock,
    setHistoryTruncated: setHistoryTruncatedMock,
  }),
}))

const loadSubagentsMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/subagent', () => ({
  useSubagentStore: () => ({ loadSubagents: loadSubagentsMock }),
  subagentVirtualId: (main: string, sub: string) => `subagent:${main}:${sub}`,
}))

const loadWorkflowsMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/workflow', () => ({
  useWorkflowStore: () => ({ loadWorkflows: loadWorkflowsMock }),
}))

const loadTreeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/useFileTree', () => ({
  useFileTree: () => ({ loadTree: loadTreeMock }),
}))

// ── mock api 域 ──
const switchSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const getHistoryMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ messages: [], historyTruncated: false })))
const getCommandsMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ commands: [] })))
const getContextMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})))
vi.mock('@/api', () => ({
  chat: { getHistory: getHistoryMock },
  extension: {},
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: switchSessionMock,
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    getCommands: getCommandsMock,
    getContext: getContextMock,
  },
}))

import { useSidebar } from '@/composables/features/useSidebar'
import { useChatStore } from '@/stores/chat'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'

function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

function makeMessage(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

function seedSessions(ids: string[]): void {
  const store = useSessionStore()
  const group: SessionGroup = { cwd: '/proj', sessions: ids.map(makeSummary) }
  store.setGroups([group])
}

/** hydrate 指定 session（绕过 selectSession 的 api 拉取，直接注入消息） */
function hydrateSession(id: string, msgs: Message[]): void {
  const chat = useChatStore()
  chat.hydrate(id, msgs)
}

describe('lru-panel-exempt-fix 方案 C：panel 绑定 session 不被 LRU 误驱逐', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    _resetLruForTest()
    vi.clearAllMocks()
    vi.useFakeTimers()
    switchSessionMock.mockResolvedValue(undefined)
    getHistoryMock.mockResolvedValue({ messages: [], historyTruncated: false })
    getCommandsMock.mockResolvedValue({ commands: [] })
    getContextMock.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('AC-1: 双 panel 下 standby 绑定 session 不被驱逐', () => {
    it('active 侧切 9 个其他 session 后，standby 侧 sessionY 仍在 messages map 中', async () => {
      const scope = effectScope()
      const sidebar = scope.run(() => useSidebar())!
      // 准备 11 个 session：Y（standby）+ 9 个填充 + X（active 起点）
      const fillerIds = Array.from({ length: 9 }, (_, i) => `filler-${i}`)
      seedSessions(['Y', 'X', ...fillerIds])

      const panel = usePanelStore()
      // 双 panel：左 panel 绑 Y（standby），右 panel 绑 X（active）
      panel.split()
      const leaves = panel.panels
      const leftPanelId = leaves[0].id
      const rightPanelId = leaves[1].id
      panel.loadSession(leftPanelId, 'Y')
      panel.loadSession(rightPanelId, 'X')
      panel.setActive(rightPanelId)

      // Y 预先 hydrate（standby 侧已有消息）
      vi.setSystemTime(1000)
      hydrateSession('Y', [makeMessage('msg-Y')])
      // X hydrate（active 起点）
      vi.setSystemTime(1001)
      hydrateSession('X', [makeMessage('msg-X')])

      // 在 active 侧切 9 个 filler session（每个间隔 10ms，时间戳都新于 Y）
      // Y 不再被 touch（方案 C 修复前：Y 时间戳最旧 → 被 LRU 驱逐；修复后：selectSession 前刷新 panel 绑定 → Y 保住）
      for (let i = 0; i < fillerIds.length; i++) {
        vi.setSystemTime(2000 + i * 10)
        // filler 预先 hydrate，selectSession 内 getHistory mock 返回空不会覆盖
        hydrateSession(fillerIds[i], [makeMessage(`msg-${fillerIds[i]}`)])
        await sidebar.selectSession(fillerIds[i], { panelId: rightPanelId })
      }

      // AC-1 断言：Y 仍在 messages map 中（未被驱逐）
      expect(useChatStore().getMessages('Y')).toHaveLength(1)
      expect(useChatStore().isHydrated('Y')).toBe(true)

      scope.stop()
    })
  })

  describe('AC-2: 单 panel LRU 基线不退化（最旧被驱逐）', () => {
    it('单 panel 下切 9 个 session，最旧的 session 被驱逐', async () => {
      const scope = effectScope()
      const sidebar = scope.run(() => useSidebar())!
      const ids = Array.from({ length: 9 }, (_, i) => `s${i}`)
      seedSessions(ids)

      const panel = usePanelStore()
      // 单 panel（默认 ROOT_PANEL_ID）
      panel.loadSession(ROOT_PANEL_ID, 's0')

      // 依次切 9 个 session（每次都绑到 ROOT_PANEL_ID，单 panel 模式）
      for (let i = 0; i < ids.length; i++) {
        vi.setSystemTime(1000 + i * 10)
        hydrateSession(ids[i], [makeMessage(`msg-${ids[i]}`)])
        await sidebar.selectSession(ids[i])
      }

      // AC-2 断言：最旧的 s0 被驱逐（LRU 基线不退化——方案 C 不能把 LRU 架空）
      expect(useChatStore().getMessages('s0')).toHaveLength(0)
      // 最新的 s8 保留
      expect(useChatStore().getMessages('s8')).toHaveLength(1)

      scope.stop()
    })
  })

  describe('AC-4: panel close 后旧 session 不再被保护', () => {
    it('close 承载 Y 的 panel 后，切足够 session 可驱逐 Y', async () => {
      const scope = effectScope()
      const sidebar = scope.run(() => useSidebar())!
      const fillerIds = Array.from({ length: 9 }, (_, i) => `filler-${i}`)
      seedSessions(['Y', 'X', ...fillerIds])

      const panel = usePanelStore()
      // 双 panel：左绑 Y，右绑 X
      panel.split()
      const leaves = panel.panels
      const leftPanelId = leaves[0].id
      const rightPanelId = leaves[1].id
      panel.loadSession(leftPanelId, 'Y')
      panel.loadSession(rightPanelId, 'X')
      panel.setActive(rightPanelId)

      vi.setSystemTime(1000)
      hydrateSession('Y', [makeMessage('msg-Y')])
      vi.setSystemTime(1001)
      hydrateSession('X', [makeMessage('msg-X')])

      // close 左 panel（承载 Y 的那侧）→ Y 不再被任何 panel 绑定
      panel.close(leftPanelId)

      // 切 9 个 filler（Y 不再被 panel 保护 → 时间戳最旧 → 被驱逐）
      for (let i = 0; i < fillerIds.length; i++) {
        vi.setSystemTime(2000 + i * 10)
        hydrateSession(fillerIds[i], [makeMessage(`msg-${fillerIds[i]}`)])
        await sidebar.selectSession(fillerIds[i])
      }

      // AC-4 断言：Y 已被驱逐（close 后不再受保护）
      expect(useChatStore().getMessages('Y')).toHaveLength(0)

      scope.stop()
    })
  })
})
