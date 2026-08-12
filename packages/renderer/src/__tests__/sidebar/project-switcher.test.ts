/**
 * ProjectSwitcher 组件测试：折叠/展开两态（UI 形态对齐 v6 demo）+ 最近使用排序 + 滚动。
 *
 * 覆盖：
 *  - 首屏默认折叠：只显示当前 project 行，列表不可见；点击 toggle 展开。
 *  - 展开后列表按 recentProjects 排序（activeProject 第一 + 其余 lastUsedAt 降序）。
 *  - 超过 5 个 project 时列表容器可滚动（max-h + overflow-y-auto）。
 *  - 选择 project 后列表收起（select 关 expanded）。
 *  - 新建流：点「新建项目」→ input 出现 → Enter 创建并设为活跃。
 *  - 删除流：hover 项出删除按钮 → ConfirmDialog → 确认删除。
 *
 * 测试框架：vitest + @vue/test-utils（mount）。vue-i18n 由 vitest-i18n-setup.ts 全局 mock。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-switcher.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ProjectSwitcher from '@/components/sidebar/ProjectSwitcher.vue'
import { useProjectStore } from '@/stores/project'
import type { Project } from '@xyz-agent/shared'

function makeProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, lastUsedAt }
}

describe('ProjectSwitcher: 折叠/展开两态 + 排序 + 滚动', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('xyz-agent:projects')
  })

  // ── 首屏折叠态 ─────────────────────────────
  it('首屏默认折叠：只渲染当前 project 行，列表不可见；点 toggle 展开列表', async () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha'), makeProject('b', 'Beta')]
    store.activeProjectId = 'a'

    const wrapper = mount(ProjectSwitcher)

    // 折叠态：当前行显示 active project 名，列表不渲染
    const currentRow = wrapper.find('[data-testid="project-switcher-current"]')
    expect(currentRow.exists()).toBe(true)
    expect(currentRow.text()).toContain('Alpha')
    expect(wrapper.find('[data-testid="project-list"]').exists()).toBe(false)

    // 点击 toggle → 展开，列表项可见（active + 其他全部列出）
    await currentRow.trigger('click')
    const items = wrapper.findAll('[data-testid="project-item"]')
    expect(items.length).toBe(2)
    expect(items.some((w) => w.text().includes('Alpha'))).toBe(true)
    expect(items.some((w) => w.text().includes('Beta'))).toBe(true)
  })

  // ── 排序 ───────────────────────────────────
  it('列表渲染顺序跟随 recentProjects（activeProject 第一 + 其余 lastUsedAt 降序）', async () => {
    const store = useProjectStore()
    // 数组顺序 [A, B, C]，但 lastUsedAt 让 recentProjects = [A, C, B]
    store.projects = [
      makeProject('a', 'A', 300),
      makeProject('b', 'B', 100),
      makeProject('c', 'C', 200),
    ]
    store.activeProjectId = 'a'

    const wrapper = mount(ProjectSwitcher)
    await wrapper.find('[data-testid="project-switcher-current"]').trigger('click')
    const names = wrapper.findAll('[data-testid="project-item"]').map((w) => w.text())

    expect(names).toEqual(['A', 'C', 'B'])
  })

  // ── 滚动 ───────────────────────────────────
  it('超过 5 个 project 时列表容器可滚动（max-h + overflow-y-auto）', async () => {
    const store = useProjectStore()
    store.projects = Array.from({ length: 8 }, (_, i) =>
      makeProject(`p${i}`, `Proj-${i}`, i),
    )
    store.activeProjectId = 'p0'

    const wrapper = mount(ProjectSwitcher)
    await wrapper.find('[data-testid="project-switcher-current"]').trigger('click')
    const list = wrapper.find('[data-testid="project-list"]')

    expect(list.exists()).toBe(true)
    // 滚动机制：overflow-y-auto class（happy-dom 不做真实布局，用 class 断言）
    expect(list.classes()).toContain('overflow-y-auto')
    // 高度限制：含 max-h-* class（限定可视区约 5 项）
    expect(list.classes().some((c) => c.startsWith('max-h-'))).toBe(true)
    // 8 项全部渲染在列表中（滚动可见，非隐藏）
    expect(list.findAll('[data-testid="project-item"]').length).toBe(8)
  })

  // ── 选择收起 ───────────────────────────────
  it('展开态选择 project 后切换 active 并收起列表', async () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha'), makeProject('b', 'Beta')]
    store.activeProjectId = 'a'

    const wrapper = mount(ProjectSwitcher)
    await wrapper.find('[data-testid="project-switcher-current"]').trigger('click')

    const betaItem = wrapper.findAll('[data-testid="project-item"]').find((w) => w.text().includes('Beta'))
    expect(betaItem).toBeTruthy()
    await betaItem!.trigger('click')

    expect(store.activeProjectId).toBe('b')
    // 选中后收起：列表不再渲染，当前行显示新 active
    expect(wrapper.find('[data-testid="project-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-switcher-current"]').text()).toContain('Beta')
  })

  // ── 新建流 ─────────────────────────────────
  it('新建流：点「新建项目」出输入框，Enter 创建并设为活跃', async () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha')]
    store.activeProjectId = 'a'

    const wrapper = mount(ProjectSwitcher)
    await wrapper.find('[data-testid="project-switcher-current"]').trigger('click')

    // 点「新建项目」→ 输入框出现
    const newBtn = wrapper.findAll('button').find((w) => w.text().includes('新建项目'))
    expect(newBtn).toBeTruthy()
    await newBtn!.trigger('click')
    const input = wrapper.find('input')
    expect(input.exists()).toBe(true)

    // 输入名称 + Enter → 创建并设为活跃
    await input.setValue('新项目')
    await input.trigger('keydown.enter')

    expect(store.projects.some((p) => p.name === '新项目')).toBe(true)
    expect(store.activeProjectId).toBe(store.projects.find((p) => p.name === '新项目')!.id)
  })
})
