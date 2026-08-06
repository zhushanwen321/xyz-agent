/**
 * project store 测试：lastUsedAt 时间戳 + recentProjects 排序（含旧数据兼容）。
 *
 * 对应 wave:sidebar-project-default-expand 的 tc-set-active-updates-ts /
 * tc-add-project-ts / tc-recent-desc / tc-recent-fallback-active-first /
 * tc-load-legacy-compat。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/project.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useProjectStore } from '@/stores/project'
import type { Project } from '@xyz-agent/shared'

const STORAGE_KEY = 'xyz-agent:projects'

function makeProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, workspaces: [], lastUsedAt }
}

describe('project store: lastUsedAt + recentProjects', () => {
  beforeEach(() => {
    // 新 pinia 实例（store 在首次 useProjectStore() 时才初始化/loadFromStorage）
    setActivePinia(createPinia())
    localStorage.removeItem(STORAGE_KEY)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── tc-set-active-updates-ts ──────────────────────────────
  it('setActiveProject 更新目标 project 的 lastUsedAt，不动其他项', () => {
    vi.setSystemTime(1000)
    const store = useProjectStore()
    store.projects = [makeProject('a', 'A', 100), makeProject('b', 'B', 50)]

    vi.setSystemTime(2000)
    store.setActiveProject('b')

    expect(store.projects.find((p) => p.id === 'b')!.lastUsedAt).toBe(2000)
    expect(store.projects.find((p) => p.id === 'a')!.lastUsedAt).toBe(100)
    expect(store.activeProjectId).toBe('b')
  })

  // ── tc-add-project-ts ─────────────────────────────────────
  it('addProject 新建时 lastUsedAt = 当前时间，设为 active，排 recentProjects 第一', () => {
    vi.setSystemTime(1000)
    const store = useProjectStore()
    store.projects = [makeProject('old', 'Old', 1000)]

    vi.setSystemTime(5000)
    const newId = store.addProject('新项目')

    const created = store.projects.find((p) => p.id === newId)!
    expect(created.lastUsedAt).toBe(5000)
    expect(store.activeProjectId).toBe(newId)
    expect(store.recentProjects[0].id).toBe(newId)
  })

  // ── tc-recent-desc ────────────────────────────────────────
  it('recentProjects 按 lastUsedAt 降序排列', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('a', 'A', 300),
      makeProject('b', 'B', 100),
      makeProject('c', 'C', 200),
    ]
    store.setActiveProject('a')

    expect(store.recentProjects.map((p) => p.id)).toEqual(['a', 'c', 'b'])
  })

  // ── tc-recent-fallback-active-first ───────────────────────
  it('recentProjects 兜底：lastUsedAt 全 0 时 activeProject 第一 + 其余数组顺序', () => {
    const store = useProjectStore()
    // 数组顺序 [X, Y, Z]，全 0
    store.projects = [makeProject('x', 'X'), makeProject('y', 'Y'), makeProject('z', 'Z')]
    store.setActiveProject('z') // setActiveProject 会把 z 的 lastUsedAt 设为当前时间——
    // 为测「全 0 兜底」，手动重置 z 的时间戳回 0（模拟旧数据未升级状态）
    store.projects.find((p) => p.id === 'z')!.lastUsedAt = 0
    store.activeProjectId = 'z'

    expect(store.recentProjects.map((p) => p.id)).toEqual(['z', 'x', 'y'])
  })

  // ── tc-load-legacy-compat ─────────────────────────────────
  it('loadFromStorage 兼容旧数据（无 lastUsedAt 字段 → 0），不崩溃', () => {
    // 在 store 首次初始化前塞入旧格式数据（Project 无 lastUsedAt 字段）
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        projects: [{ id: 'legacy', name: 'Legacy', workspaces: [] }],
        activeProjectId: 'legacy',
      }),
    )

    const store = useProjectStore() // 触发 loadFromStorage

    expect(store.projects[0].lastUsedAt).toBe(0)
    expect(store.activeProjectId).toBe('legacy')
  })
})
