/**
 * SessionList.vue 按 activeProject 过滤测试（D14：Project → Workspace(cwd) → Session 关联）。
 *
 * 用户主诉求回归防护：切换项目时，session 列表必须跟随 activeProject 变化——
 * 默认 project（name 空）显示全部；命名 project 只显示其 workspaces 对应 cwd 的组。
 *
 * 覆盖（含渲染 gate：断言 DOM 中实际渲染的分组标题）：
 * - 默认 project → 全部组渲染（现有体验不破坏）
 * - 命名 project + 归因 cwd → 只渲染匹配组
 * - 命名 project 无归因 → 空态（暂无会话 + 新建按钮）
 * - 切 project（A → B）→ 列表实时变化
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-project-filter.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup } from '@xyz-agent/shared'
import SessionList from '@/components/sidebar/SessionList.vue'
import { useProjectStore } from '@/stores/project'
import type { Project } from '@xyz-agent/shared'

function makeGroups(): SessionGroup[] {
  return [
    {
      cwd: '/repo-a',
      sessions: [
        { id: 's1', label: '会话 A1', cwd: '/repo-a', status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0 } as SessionGroup['sessions'][number],
      ],
    },
    {
      cwd: '/repo-b',
      sessions: [
        { id: 's2', label: '会话 B1', cwd: '/repo-b', status: 'idle', lastActiveAt: 2, modelId: 'm', tokenCount: 0 } as SessionGroup['sessions'][number],
      ],
    },
  ]
}

function makeProject(id: string, name: string): Project {
  return { id, name, workspaces: [], lastUsedAt: 0 }
}

function mountList() {
  return mount(SessionList, {
    props: {
      groups: makeGroups(),
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

/** 分组标题（cwd 末段）断言：目录名文本渲染在 folder 标题行 */
function groupTitles(wrapper: ReturnType<typeof mountList>): string[] {
  return wrapper.findAll('.group-section').map((w) => w.text())
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('xyz-agent:projects')
})

describe('SessionList: 默认 project 显示全部（现状不破坏）', () => {
  it('默认 project（name 空）→ 两组 session 全部渲染', () => {
    const wrapper = mountList()
    expect(wrapper.text()).toContain('会话 A1')
    expect(wrapper.text()).toContain('会话 B1')
  })
})

describe('SessionList: 命名 project 按 workspaces 过滤', () => {
  it('命名 project + 归因 cwd → 只渲染匹配组的 session', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'
    store.addWorkspace('/repo-a')

    const wrapper = mountList()

    // 渲染 gate：匹配组在 DOM，非匹配组不渲染
    expect(wrapper.text()).toContain('会话 A1')
    expect(wrapper.text()).not.toContain('会话 B1')
  })

  it('命名 project + 未归因任何目录 → 空态（暂无会话 + 新建按钮）', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'

    const wrapper = mountList()

    expect(wrapper.text()).not.toContain('会话 A1')
    expect(wrapper.text()).not.toContain('会话 B1')
    // 空态占位文案（sidebar.sessionList.empty）
    expect(wrapper.text()).toContain('暂无会话')
  })

  it('归因目录后实时出现（addWorkspace 触发重渲染）', async () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'

    const wrapper = mountList()
    expect(wrapper.text()).not.toContain('会话 A1')

    store.addWorkspace('/repo-a')
    await nextTick()

    expect(wrapper.text()).toContain('会话 A1')
  })
})

describe('SessionList: 切换 project 列表实时变化（用户主诉求回归防护）', () => {
  it('切 project（A 归因 repo-a → B 归因 repo-b）→ 列表从 A 组变为 B 组', async () => {
    const store = useProjectStore()
    store.projects = [
      { ...makeProject('a', 'Alpha'), workspaces: [{ id: 'w1', cwd: '/repo-a', dir: 'repo-a', repo: '', isMain: false }] },
      { ...makeProject('b', 'Beta'), workspaces: [{ id: 'w2', cwd: '/repo-b', dir: 'repo-b', repo: '', isMain: false }] },
    ]
    store.activeProjectId = 'a'

    const wrapper = mountList()
    // A 项目：只显示 repo-a 组
    expect(wrapper.text()).toContain('会话 A1')
    expect(wrapper.text()).not.toContain('会话 B1')

    // 切到 B 项目：列表实时变为 repo-b 组
    store.setActiveProject('b')
    await nextTick()

    expect(wrapper.text()).toContain('会话 B1')
    expect(wrapper.text()).not.toContain('会话 A1')
  })

  it('切回默认 project → 恢复显示全部', async () => {
    const store = useProjectStore()
    store.projects = [
      { ...makeProject('a', 'Alpha'), workspaces: [{ id: 'w1', cwd: '/repo-a', dir: 'repo-a', repo: '', isMain: false }] },
      { ...makeProject('def', ''), workspaces: [] },
    ]
    store.activeProjectId = 'a'

    const wrapper = mountList()
    expect(wrapper.text()).not.toContain('会话 B1')

    store.setActiveProject('def')
    await nextTick()

    expect(wrapper.text()).toContain('会话 A1')
    expect(wrapper.text()).toContain('会话 B1')
  })
})
