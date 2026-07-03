/**
 * workspaceStore 单测 —— W3 前端改接 workspaceStore。
 *
 * 覆盖：
 * - T3.1: defaultCwd = records[0]?.cwd
 * - T3.2: records 空 → defaultCwd undefined
 * - T3.4: RPC reject 降级（records 置 [] 不抛）
 *
 * mock 策略：mock workspaceApi.listRecent 返回值。
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/workspace-store.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'

// mock @/api 门面的 workspace（store 走门面，mock 路径须与 store import 一致；vi.mock 自动 hoist）
vi.mock('@/api', () => ({
  workspace: { listRecent: vi.fn() },
}))

import { useWorkspaceStore } from '@/stores/workspace'
import { workspace } from '@/api'

// store 现经门面调 workspace.listRecent；mock 后此处即 vi.fn 实例
const mockListRecent = workspace.listRecent as unknown as ReturnType<typeof vi.fn>

function mkRecord(cwd: string, lastUsedAt: number): RecentWorkspaceRecord {
  return { cwd, lastUsedAt, label: cwd.split('/').filter(Boolean).pop() ?? cwd }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockListRecent.mockReset()
})

describe('workspaceStore.load（T3.1 / T3.2）', () => {
  it('T3.1: defaultCwd = records[0]?.cwd（首条记录的 cwd）', async () => {
    mockListRecent.mockResolvedValue([
      mkRecord('/repo-a', 300),
      mkRecord('/repo-b', 200),
    ])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBe('/repo-a')
    expect(store.records).toHaveLength(2)
  })

  it('T3.2: records 空 → defaultCwd undefined', async () => {
    mockListRecent.mockResolvedValue([])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBeUndefined()
    expect(store.records).toEqual([])
  })
})

describe('workspaceStore.load 降级（T3.4）', () => {
  it('RPC reject → records 置 [] 不抛', async () => {
    mockListRecent.mockRejectedValue(new Error('RPC timeout'))
    const store = useWorkspaceStore()
    // 不抛
    await store.load()
    expect(store.records).toEqual([])
    expect(store.defaultCwd).toBeUndefined()
  })
})
