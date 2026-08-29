/**
 * Project 排序与 reorder 单测（ProjectSwitcher 3A，D7 两段式排序 + drop 密集重排）。
 *
 * 覆盖（u5 验收①四类 + badge 共享计数规则）：
 *  - 两段式排序：有 userOrder 升序在前段；无 userOrder 按 active 置顶 + lastUsedAt 降序在后段
 *  - A5 新建项目落位：addProject 的新项目落在用户序段之后、自动序段首位（active 置顶）
 *  - drop 密集重排：reorderProject 提交后用户序段（旧有序段 ∪ 被拖卡）重编号 0..n-1，
 *    消除稀疏（拖到首位即首位 / 中间即中间 / 删除遗留空洞被重编）
 *  - 默认项目同卡同权：可获 userOrder、参与两段排序
 *  - 切换 active 不重排有序段：setActiveProject 只更新 lastUsedAt，用户序段顺序不变
 *  - sessionBelongsToProject / computeProjectSessionCounts：badge 计数与 SessionList
 *    过滤同一规则（命名精确匹配；默认聚合未归类 + 孤儿）
 *
 * mock 策略：mock @/api 门面的 project 域（store 走门面，同 project-store.test.ts）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-ordering.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Project, SessionGroup } from '@xyz-agent/shared'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import {
  sessionBelongsToProject,
  computeProjectSessionCounts,
} from '@/composables/logic/project-session'

vi.mock('@/api', () => ({
  project: { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
}))

function makeProject(id: string, name: string, lastUsedAt = 0, userOrder?: number): Project {
  return userOrder === undefined ? { id, name, lastUsedAt } : { id, name, lastUsedAt, userOrder }
}

/** 断言 userOrder 按给定 id 顺序密集编号 0..n-1 */
function expectDenseOrder(store: ReturnType<typeof useProjectStore>, ids: string[]) {
  ids.forEach((id, expected) => {
    expect(store.projects.find((p) => p.id === id)!.userOrder).toBe(expected)
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('recentProjects 两段式排序（D7）', () => {
  it('有 userOrder 的升序排前段；无 userOrder 按 active 置顶 + lastUsedAt 降序排后段', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('a', 'A', 300, 1),
      makeProject('b', 'B', 100, 0),
      makeProject('c', 'C', 300),
      makeProject('d', 'D', 100),
    ]
    store.activeProjectId = 'c'

    // 用户序段 [B(0), A(1)] 在前；自动序段 active C 置顶 + D 按 lastUsedAt 在后
    expect(store.recentProjects.map((p) => p.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('activeProject 落在用户序段时不再置顶（其 userOrder 位次即显示位次）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('z', 'Z', 999),
    ]
    store.activeProjectId = 'x2'

    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'x2', 'z'])
  })

  it('自动序段内部维持旧规则全语义：active 置顶 + lastUsedAt 降序 + 同值稳定', () => {
    const store = useProjectStore()
    // 全员无 userOrder = 旧行为（回归锚点）
    store.projects = [
      makeProject('a', 'A', 300),
      makeProject('b', 'B', 100),
      makeProject('c', 'C', 200),
    ]
    store.activeProjectId = 'a'
    expect(store.recentProjects.map((p) => p.id)).toEqual(['a', 'c', 'b'])
  })

  it('A5 新建项目落位：无有序卡时 addProject 后新项目为 recentProjects[0]（active 置顶）', () => {
    const store = useProjectStore()
    store.projects = [makeProject(DEFAULT_PROJECT_ID, '', 0)]
    store.activeProjectId = DEFAULT_PROJECT_ID

    const newId = store.addProject('Fresh')

    // 新项目无 userOrder（自动序段）且被设为 active → 置顶
    expect(store.recentProjects.map((p) => p.id)).toEqual([newId, DEFAULT_PROJECT_ID])
  })

  it('A5 新建项目落位：有有序卡时新项目位于用户序段之后、自动序段首位', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject(DEFAULT_PROJECT_ID, '', 100),
    ]
    store.activeProjectId = 'x1'

    const newId = store.addProject('Fresh')

    // 新项目不进用户序段（未拖拽），但作为 active 置顶自动序段 → 夹在两段交界处
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'x2', newId, DEFAULT_PROJECT_ID])
  })
})

describe('reorderProject：drop 位置密集重排（D7 赋号语义）', () => {
  it('用户序段内拖动：段内换位后整段密集重编号 0..n-1', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('x3', 'X3', 0, 2),
    ]
    store.activeProjectId = 'x1'

    // 把末位拖到首位（拖到首位即首位，非尾部——D7 被否方案的反例锚点）
    store.reorderProject('x3', 'x1')

    expect(store.recentProjects.map((p) => p.id)).toEqual(['x3', 'x1', 'x2'])
    expectDenseOrder(store, ['x3', 'x1', 'x2'])
  })

  it('自动序卡首次拖到用户序段首位：插入落点、连同用户序段一起密集编号', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('a', 'A', 500),
    ]
    store.activeProjectId = 'x1'

    store.reorderProject('a', 'x1')

    expect(store.recentProjects.map((p) => p.id)).toEqual(['a', 'x1', 'x2'])
    expectDenseOrder(store, ['a', 'x1', 'x2'])
  })

  it('自动序卡拖到用户序段中间位置：落点即位次（A5 中间位置场景）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('a', 'A', 500),
    ]
    store.activeProjectId = 'x1'

    store.reorderProject('a', 'x2')

    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'a', 'x2'])
    expectDenseOrder(store, ['x1', 'a', 'x2'])
  })

  it('稀疏 userOrder（删除项目遗留空洞）被下一次 reorder 消除为 0..n-1', () => {
    const store = useProjectStore()
    // 模拟删除 x2 后遗留 userOrder [0, 2] 的稀疏段
    store.projects = [makeProject('x1', 'X1', 0, 0), makeProject('x3', 'X3', 0, 2)]
    store.activeProjectId = 'x1'

    store.reorderProject('x3', 'x1')

    expectDenseOrder(store, ['x3', 'x1'])
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x3', 'x1'])
  })

  it('未拖动的自动序项目保持无 userOrder（不被迫赋假顺序）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('a', 'A', 500),
      makeProject('b', 'B', 400),
    ]
    store.activeProjectId = 'x1'

    store.reorderProject('a', 'x1')

    expect(store.projects.find((p) => p.id === 'b')!.userOrder).toBeUndefined()
  })

  it('守卫：同卡拖到自身 / 未知 id 不产生任何变更', () => {
    const store = useProjectStore()
    store.projects = [makeProject('x1', 'X1', 0, 0), makeProject('a', 'A', 1)]
    store.activeProjectId = 'x1'

    store.reorderProject('x1', 'x1')
    store.reorderProject('x1', 'ghost-id')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'a'])
    expectDenseOrder(store, ['x1'])
  })
})

describe('默认项目同卡同权（D7）', () => {
  it('默认项目可被拖拽赋 userOrder，与命名项目同规则参与两段排序', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject(DEFAULT_PROJECT_ID, '', 0),
      makeProject('x1', 'X1', 0, 0),
      makeProject('a', 'A', 500),
    ]
    store.activeProjectId = 'x1'

    // 默认项目拖到用户序段首位
    store.reorderProject(DEFAULT_PROJECT_ID, 'x1')

    expect(store.recentProjects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'x1', 'a'])
    expect(store.projects.find((p) => p.id === DEFAULT_PROJECT_ID)!.userOrder).toBe(0)
    expectDenseOrder(store, [DEFAULT_PROJECT_ID, 'x1'])
  })

  it('无 userOrder 时默认项目与命名项目同落自动序段（lastUsedAt 降序）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject(DEFAULT_PROJECT_ID, '', 100),
      makeProject('a', 'A', 300),
    ]
    store.activeProjectId = 'a'

    expect(store.recentProjects.map((p) => p.id)).toEqual(['a', DEFAULT_PROJECT_ID])
  })
})

describe('切换 active 不重排有序段（D7：切换 ≠ 排序意图）', () => {
  it('在用户序段内来回切换 active，显示顺序保持 userOrder 不变', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('x3', 'X3', 0, 2),
      makeProject('z', 'Z', 999),
    ]
    store.activeProjectId = 'x1'

    store.setActiveProject('x3')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'x2', 'x3', 'z'])

    store.setActiveProject('x2')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'x2', 'x3', 'z'])

    // lastUsedAt 被更新，但用户序段排序仍与 lastUsedAt 无关
    expect(store.projects.find((p) => p.id === 'x2')!.lastUsedAt).toBeGreaterThan(0)
    expectDenseOrder(store, ['x1', 'x2', 'x3'])
  })

  it('切换到自动序项目：自动序段内置顶，用户序段不受影响', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('a', 'A', 500),
      makeProject('b', 'B', 100),
    ]
    store.activeProjectId = 'x1'

    store.setActiveProject('b')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'b', 'a'])
  })
})

// ── badge 共享计数规则（与 SessionList 过滤同一 SSOT）─────────────
function session(id: string, projectId?: string) {
  return { id, projectId }
}

describe('sessionBelongsToProject / computeProjectSessionCounts（badge 规则 SSOT）', () => {
  const groups: SessionGroup[] = [
    {
      cwd: '/repo',
      sessions: [
        session('s-a1', 'proj-a'),
        session('s-orphan', 'proj-gone'),
        session('s-free'),
      ] as SessionGroup['sessions'],
    },
    {
      cwd: '/repo2',
      sessions: [session('s-a2', 'proj-a'), session('s-b1', 'proj-b')] as SessionGroup['sessions'],
    },
  ]
  const projects = [
    makeProject('proj-default', ''),
    makeProject('proj-a', 'Alpha'),
    makeProject('proj-b', 'Beta'),
  ]
  const namedIds = new Set(['proj-a', 'proj-b'])

  it('命名 project：精确匹配 projectId', () => {
    expect(sessionBelongsToProject({ projectId: 'proj-a' }, 'proj-a', false, namedIds)).toBe(true)
    expect(sessionBelongsToProject({ projectId: 'proj-b' }, 'proj-a', false, namedIds)).toBe(false)
    expect(sessionBelongsToProject({}, 'proj-a', false, namedIds)).toBe(false)
  })

  it('默认项目：未归类 + 孤儿聚合（归属的 project 已删除）', () => {
    expect(sessionBelongsToProject({}, DEFAULT_PROJECT_ID, true, namedIds)).toBe(true)
    expect(sessionBelongsToProject({ projectId: 'proj-gone' }, DEFAULT_PROJECT_ID, true, namedIds)).toBe(true)
    expect(sessionBelongsToProject({ projectId: 'proj-a' }, DEFAULT_PROJECT_ID, true, namedIds)).toBe(false)
  })

  it('computeProjectSessionCounts：每卡计数 = 点击后 SessionList 过滤显示数', () => {
    const counts = computeProjectSessionCounts(groups, projects)
    expect(counts.get('proj-a')).toBe(2)
    expect(counts.get('proj-b')).toBe(1)
    expect(counts.get('proj-default')).toBe(2) // s-orphan + s-free
  })
})
