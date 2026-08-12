/**
 * Project store 测试（D14 语义修正 + 2026-08-04 持久化迁 runtime projects.json）。
 *
 * 覆盖：
 * - 同步初始态：默认 project 兜底（UI 永不空态）
 * - init()：RPC load 权威数据；RPC 失败降级默认；localStorage 一次性迁移（有旧数据 → 用之 + save 回 runtime）
 * - addProject / setActiveProject / removeProject CRUD + lastUsedAt 排序
 * - isDefaultProject 判定（name 空）
 * - deep watch 变化 → RPC save 被调
 *
 * mock 策略：mock @/api 门面的 project 域（store 走门面）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-store.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { Project, ProjectStoreState } from '@xyz-agent/shared'
import { useProjectStore, STORAGE_KEY, DEFAULT_PROJECT_ID } from '@/stores/project'

vi.mock('@/api', () => ({
  project: { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
}))

import { project as projectApi } from '@/api'

const mockLoad = projectApi.load as unknown as ReturnType<typeof vi.fn>
const mockSave = projectApi.save as unknown as ReturnType<typeof vi.fn>

function makeProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, lastUsedAt }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem(STORAGE_KEY)
  // mockClear 而非 mockReset：mockReset 会清掉 mockResolvedValue 实现（save 返回 undefined → .catch 崩）
  mockLoad.mockClear()
  mockSave.mockClear()
})

describe('Project store: 初始态与 init()', () => {
  it('同步初始态：默认 project 兜底（RPC 未返回前 UI 不空）', () => {
    const store = useProjectStore()
    expect(store.projects).toHaveLength(1)
    expect(store.activeProject!.name).toBe('')
    expect(store.isDefaultProject).toBe(true)
  })

  it('init()：RPC load 权威数据替换默认态（含 activeProjectId）', async () => {
    mockLoad.mockResolvedValue({
      projects: [makeProject('proj-a', 'Alpha'), makeProject('proj-default', '', 0)],
      activeProjectId: 'proj-a',
    })
    const store = useProjectStore()
    await store.init()

    expect(store.projects).toHaveLength(2)
    expect(store.activeProjectId).toBe('proj-a')
    expect(store.isDefaultProject).toBe(false)
  })

  it('init()：RPC reject 降级默认（不抛，不阻断启动）', async () => {
    mockLoad.mockRejectedValue(new Error('runtime not ready'))
    const store = useProjectStore()
    await expect(store.init()).resolves.toBeUndefined()
    expect(store.projects).toHaveLength(1)
    expect(store.activeProject!.name).toBe('')
  })

  it('init()：runtime 空 + localStorage 有旧数据 → 一次性迁移（用之 + save 回 runtime）', async () => {
    mockLoad.mockResolvedValue({ projects: [], activeProjectId: '' })
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        projects: [{ id: 'p1', name: '旧项目', workspaces: [{ id: 'w1', cwd: '/x', dir: 'x', repo: '', isMain: false }], lastUsedAt: 100 }],
        activeProjectId: 'p1',
      }),
    )
    const store = useProjectStore()
    await store.init()

    expect(store.projects[0]!.name).toBe('旧项目')
    // 旧 workspaces 字段被剥离
    expect('workspaces' in store.projects[0]!).toBe(false)
    // 迁移写回 runtime
    expect(mockSave).toHaveBeenCalled()
    const saved = mockSave.mock.calls[0][0] as ProjectStoreState
    expect(saved.projects[0]!.id).toBe('p1')
  })

  it('init()：runtime 空 + localStorage 无数据 → 保持默认 project', async () => {
    mockLoad.mockResolvedValue({ projects: [], activeProjectId: '' })
    const store = useProjectStore()
    await store.init()
    expect(store.projects).toHaveLength(1)
    expect(store.activeProject!.name).toBe('')
  })
})

describe('Project store: CRUD + 持久化', () => {
  it('addProject：新建 + 设为活跃 + 返回 id；空名不创建', () => {
    const store = useProjectStore()
    const id = store.addProject('测试项目')
    expect(id).toBeTruthy()
    expect(store.projects).toHaveLength(2)
    expect(store.activeProjectId).toBe(id)
    expect(store.isDefaultProject).toBe(false)

    store.addProject('   ')
    expect(store.projects).toHaveLength(2)
  })

  it('setActiveProject：切换 + lastUsedAt 更新（驱动 recentProjects 排序）', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    const b = store.addProject('B')
    store.setActiveProject(a)

    expect(store.activeProjectId).toBe(a)
    expect(store.recentProjects[0]!.id).toBe(a)
    expect(store.recentProjects[1]!.id).toBe(b)
  })

  it('setActiveProject 更新目标 lastUsedAt，不动其他项；addProject 新建时 lastUsedAt = 当前时间', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    const b = store.addProject('B')
    const aBefore = store.projects.find((p) => p.id === a)!.lastUsedAt
    const bBefore = store.projects.find((p) => p.id === b)!.lastUsedAt

    store.setActiveProject(a)

    expect(store.projects.find((p) => p.id === a)!.lastUsedAt).toBeGreaterThanOrEqual(aBefore)
    expect(store.projects.find((p) => p.id === b)!.lastUsedAt).toBe(bBefore) // 未动
    // addProject 用 Date.now()（同毫秒可能相等，断言不小于创建前时间即可）
    expect(store.projects.find((p) => p.id === b)!.lastUsedAt).toBeGreaterThan(0)
  })

  it('removeProject：默认项目不可删；保底不删最后一个；删活跃项自动切首个', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    const b = store.addProject('B')
    store.setActiveProject(a)

    store.removeProject(a)
    expect(store.projects).toHaveLength(2) // 默认 + B
    expect(store.activeProjectId).not.toBe(a)

    // 默认项目（DEFAULT_PROJECT_ID）不可删除（review MF-1 守卫：未归类 session 的兜底聚合）
    store.removeProject(DEFAULT_PROJECT_ID)
    expect(store.projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, b])

    store.removeProject(b)
    expect(store.projects).toHaveLength(1) // 只剩默认（保底不删最后一个）
    store.removeProject(store.projects[0]!.id)
    expect(store.projects).toHaveLength(1) // 默认项目守卫再拦一次
  })

  it('isDefaultProject：命名 project 非默认；默认 project（name 空）是默认', () => {
    const store = useProjectStore()
    expect(store.isDefaultProject).toBe(true)
    store.addProject('Alpha')
    expect(store.isDefaultProject).toBe(false)
  })

  it('deep watch 变化 → RPC save 全量调用', async () => {
    const store = useProjectStore()
    store.addProject('Alpha')
    await nextTick()

    expect(mockSave).toHaveBeenCalled()
    const saved = mockSave.mock.calls[0][0] as ProjectStoreState
    expect(saved.projects.some((p) => p.name === 'Alpha')).toBe(true)
    expect(saved.activeProjectId).toBe(store.activeProjectId)
  })
})
