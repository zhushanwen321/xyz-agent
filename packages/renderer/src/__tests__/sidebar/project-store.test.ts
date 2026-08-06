/**
 * Project store 测试（D14 语义修正 2026-08-04：Project 直接关联 Session，无 Workspace 实体）。
 *
 * 覆盖：
 * - 默认 project 兜底（localStorage 空 → proj-default，name 空）
 * - addProject / setActiveProject / removeProject CRUD + lastUsedAt 排序
 * - isDefaultProject 判定（name 空）
 * - localStorage 持久化 + 旧数据兼容（workspaces 字段剥离、lastUsedAt 补 0）
 *
 * 测试框架：vitest + pinia（store 层单测，不 mount 组件）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-store.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { Project } from '@xyz-agent/shared'
import { useProjectStore, STORAGE_KEY } from '@/stores/project'

function makeProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, lastUsedAt }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem(STORAGE_KEY)
})

describe('Project store: 默认 project 兜底', () => {
  it('localStorage 空 → 单个默认 project（name 空），activeProjectId 指向它', () => {
    const store = useProjectStore()
    expect(store.projects).toHaveLength(1)
    expect(store.activeProject!.name).toBe('')
    expect(store.isDefaultProject).toBe(true)
  })

  it('损坏 JSON → 回退默认 project 不崩', () => {
    localStorage.setItem(STORAGE_KEY, '{broken json')
    const store = useProjectStore()
    expect(store.projects).toHaveLength(1)
    expect(store.activeProject!.name).toBe('')
  })
})

describe('Project store: CRUD', () => {
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
    // recentProjects：active 第一 + 其余 lastUsedAt 降序
    expect(store.recentProjects[0]!.id).toBe(a)
    expect(store.recentProjects[1]!.id).toBe(b)
  })

  it('removeProject：保底不删最后一个；删活跃项自动切首个', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    store.addProject('B')
    store.setActiveProject(a)

    store.removeProject(a)
    expect(store.projects).toHaveLength(2) // 默认 + B
    expect(store.activeProjectId).not.toBe(a) // 删的是活跃项 → 自动切首个（默认）

    // 删到只剩 1 个后 → no-op（保底守卫）
    store.removeProject(store.projects[0]!.id)
    expect(store.projects).toHaveLength(1)
    store.removeProject(store.projects[0]!.id)
    expect(store.projects).toHaveLength(1)
  })
})

describe('Project store: isDefaultProject', () => {
  it('命名 project 非默认；默认 project（name 空）是默认', () => {
    const store = useProjectStore()
    expect(store.isDefaultProject).toBe(true)
    store.addProject('Alpha')
    expect(store.isDefaultProject).toBe(false)
  })
})

describe('Project store: localStorage 持久化与旧数据兼容', () => {
  it('addProject 后 deep watch 写入 localStorage', async () => {
    const store = useProjectStore()
    store.addProject('Alpha')
    await nextTick()

    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!) as { projects: Project[] }
    expect(parsed.projects.some((p) => p.name === 'Alpha')).toBe(true)
  })

  it('旧数据（2026-08-04 前含 workspaces 字段）→ 剥离 workspaces + lastUsedAt 补 0', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        projects: [{ id: 'p1', name: '旧项目', workspaces: [{ id: 'w1', cwd: '/repo', dir: 'repo', repo: '', isMain: false }], lastUsedAt: 100 }],
        activeProjectId: 'p1',
      }),
    )
    const store = useProjectStore()
    expect(store.projects[0]!.name).toBe('旧项目')
    // workspaces 字段被剥离（模型已无此字段）
    expect('workspaces' in store.projects[0]!).toBe(false)
    expect(store.projects[0]!.lastUsedAt).toBe(100)
  })

  it('旧数据无 lastUsedAt → 补 0（视为未用过）', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ projects: [{ id: 'p1', name: '旧项目' }], activeProjectId: 'p1' }),
    )
    const store = useProjectStore()
    expect(store.projects[0]!.lastUsedAt).toBe(0)
  })
})
