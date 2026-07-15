/**
 * W2 红灯测试：selectSession 切换 session 时主动拉取 subagent/workflow 列表。
 *
 * 核心不变量（修复问题 1）：
 * - selectSession 后 subagentStore.loadSubagents 被调用（对齐 commands/context 主动兜底）
 * - selectSession 后 workflowStore.loadWorkflows 被调用
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/select-session-pull.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// mock @/api 整个门面（useSidebar import { session as sessionApi } from '@/api'，
// VITE_MOCK=true 下走 mock 门面，直接 mock 门面层最干净）
vi.mock('@/api', () => ({
  session: {
    switchSession: vi.fn().mockResolvedValue(undefined),
    getCommands: vi.fn().mockResolvedValue({ commands: [] }),
    getContext: vi.fn().mockResolvedValue({}),
    getHistory: vi.fn().mockResolvedValue([]),
    getSubagents: vi.fn().mockResolvedValue([]),
    getWorkflows: vi.fn().mockResolvedValue([]),
  },
  chat: {
    getHistory: vi.fn().mockResolvedValue([]),
  },
  extension: {
    scan: vi.fn().mockResolvedValue(undefined),
  },
  file: {
    tree: vi.fn().mockResolvedValue({}),
  },
  git: {
    status: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/api/events', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))

import { useSidebar } from '@/composables/features/useSidebar'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('W2: selectSession 主动拉取 subagent/workflow 列表', () => {
  it('selectSession 后 loadSubagents 被调用', async () => {
    const sidebar = useSidebar()
    const subagentStore = useSubagentStore()
    const spy = vi.spyOn(subagentStore, 'loadSubagents')

    await sidebar.selectSession('sess-target')

    expect(spy).toHaveBeenCalledWith('sess-target')
  })

  it('selectSession 后 loadWorkflows 被调用', async () => {
    const sidebar = useSidebar()
    const workflowStore = useWorkflowStore()
    const spy = vi.spyOn(workflowStore, 'loadWorkflows')

    await sidebar.selectSession('sess-target')

    expect(spy).toHaveBeenCalledWith('sess-target')
  })
})
