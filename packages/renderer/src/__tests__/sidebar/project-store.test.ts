/**
 * Project store workspace 归因测试（D14：Project → Workspace(cwd) → Session 关联）。
 *
 * 覆盖：
 * - addWorkspace：命名 project 下新增 + 按 cwd dedup + 默认 project（name 空）守卫
 * - activeWorkspaceCwds：派生 cwd 集合 + 旧持久化数据（无 cwd 的 workspace）过滤
 * - removeWorkspace：从 activeProject 移除
 * - localStorage 持久化（deep watch 写入）
 *
 * 测试框架：vitest + pinia（store 层单测，不 mount 组件）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-store.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { Project } from '@xyz-agent/shared'
import { useProjectStore } from '@/stores/project'

const STORAGE_KEY = 'xyz-agent:projects'

function makeProject(id: string, name: string): Project {
  return { id, name, workspaces: [], lastUsedAt: 0 }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem(STORAGE_KEY)
})

describe('Project store: addWorkspace 自动归因', () => {
  it('命名 project 下 addWorkspace 新增 workspace（含 cwd + dir basename）', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'

    const added = store.addWorkspace('/Users/x/xyz-agent-workspace/main')

    expect(added).toBe(true)
    expect(store.activeProject!.workspaces).toHaveLength(1)
    const ws = store.activeProject!.workspaces[0]
    expect(ws.cwd).toBe('/Users/x/xyz-agent-workspace/main')
    expect(ws.dir).toBe('main')
    expect(ws.id).toBeTruthy()
  })

  it('同 cwd 重复归因 dedup（返回 false，不重复添加）', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'

    expect(store.addWorkspace('/repo')).toBe(true)
    expect(store.addWorkspace('/repo')).toBe(false)
    expect(store.addWorkspace('/repo')).toBe(false)
    expect(store.activeProject!.workspaces).toHaveLength(1)
  })

  it('默认 project（name 空）不归因——显示全部语义，无需归因', () => {
    const store = useProjectStore()
    // 默认 project（localStorage 空 → name ''）
    expect(store.activeProject!.name).toBe('')
    expect(store.addWorkspace('/repo')).toBe(false)
    expect(store.activeProject!.workspaces).toHaveLength(0)
  })

  it('空 cwd 不归因', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'
    expect(store.addWorkspace('')).toBe(false)
  })

  it('addWorkspace 只作用于 activeProject，不影响其他 project', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha'), makeProject('b', 'Beta')]
    store.activeProjectId = 'a'

    store.addWorkspace('/repo-a')

    expect(store.projects.find((p) => p.id === 'a')!.workspaces).toHaveLength(1)
    expect(store.projects.find((p) => p.id === 'b')!.workspaces).toHaveLength(0)
  })
})

describe('Project store: removeWorkspace', () => {
  it('从 activeProject 移除指定 cwd', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'
    store.addWorkspace('/repo-1')
    store.addWorkspace('/repo-2')

    store.removeWorkspace('/repo-1')

    expect(store.activeProject!.workspaces.map((w) => w.cwd)).toEqual(['/repo-2'])
  })

  it('移除不存在的 cwd 是 no-op', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'
    store.addWorkspace('/repo-1')

    store.removeWorkspace('/nope')

    expect(store.activeProject!.workspaces).toHaveLength(1)
  })
})

describe('Project store: activeWorkspaceCwds 派生', () => {
  it('返回 activeProject 全部有效 cwd', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'
    store.addWorkspace('/repo-1')
    store.addWorkspace('/repo-2')

    expect(store.activeWorkspaceCwds).toEqual(['/repo-1', '/repo-2'])
  })

  it('旧持久化数据（workspace 无 cwd 字段）被过滤，不崩', () => {
    const store = useProjectStore()
    // 模拟模型升级前的旧数据：workspace 只有 id/dir 无 cwd
    store.projects = [
      {
        id: 'a',
        name: 'Alpha',
        workspaces: [
          { id: 'w1', cwd: '', dir: 'main', repo: '', isMain: true },
          { id: 'w2', cwd: '/repo-2', dir: 'feat', repo: '', isMain: false },
        ] as Project['workspaces'],
        lastUsedAt: 0,
      },
    ]
    store.activeProjectId = 'a'

    expect(store.activeWorkspaceCwds).toEqual(['/repo-2'])
  })
})

describe('Project store: localStorage 持久化', () => {
  it('addWorkspace 后 deep watch 写入 localStorage', async () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'

    store.addWorkspace('/repo')
    // store 的 watch 默认 flush:'pre'（异步），需 nextTick 等 flush
    await nextTick()

    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!) as { projects: Project[] }
    expect(parsed.projects[0].workspaces.map((w) => w.cwd)).toEqual(['/repo'])
  })
})
