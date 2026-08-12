/**
 * ProjectSwitcher 组件测试：折叠/展开两态（UI 形态对齐 v6 demo）+ 最近使用排序 + 滚动。
 *
 * 覆盖：
 *  - 首屏默认折叠：只显示当前 project 行，列表不可见；点击 toggle 展开。
 *  - 展开后列表按 recentProjects 排序（activeProject 第一 + 其余 lastUsedAt 降序）。
 *  - 超过 5 个 project 时列表容器可滚动（max-h + overflow-y-auto）。
 *  - 选择 project 后列表收起（select 关 expanded）。
 *  - 新建流：点「新建项目」→ input 出现 → Enter 创建并设为活跃。
 *  - 删除流：hover 项出删除按钮 → ConfirmDialog → 确认删除（默认项目行永不渲染删除按钮；
 *    取消路径不删除；删活跃项自动切首个）。
 *
 * 测试框架：vitest + @vue/test-utils（mount）。vue-i18n 由 vitest-i18n-setup.ts 全局 mock。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-switcher.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ProjectSwitcher from '@/components/sidebar/ProjectSwitcher.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import type { Project } from '@xyz-agent/shared'

function makeProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, lastUsedAt }
}

/** ConfirmDialog 经 reka DialogPortal teleport 到 body：在 body 内找确认/取消按钮（同 command-popover-landing 范式）。 */
function findDialogButton(text: string): HTMLElement | null {
  return Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) ?? null
}

/** 删除流用例共享 wrapper：afterEach 统一 unmount，避免 teleport 内容在 body 残留叠加。 */
let wrapper: ReturnType<typeof mount> | null = null

describe('ProjectSwitcher: 折叠/展开两态 + 排序 + 滚动', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('xyz-agent:projects')
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
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

  // ── 删除流（review MF-4：补删除按钮显隐 + ConfirmDialog + 确认/取消 + 删活跃切首个）──
  it('删除流：默认项目行永不渲染删除按钮；仅默认 project 时列表无任何删除按钮', async () => {
    const store = useProjectStore()
    // 默认态（仅默认 project）：展开后无删除按钮
    const w1 = mount(ProjectSwitcher)
    await w1.find('[data-testid="project-switcher-current"]').trigger('click')
    expect(w1.findAll('[title="删除项目"]').length).toBe(0)
    w1.unmount()

    // 默认 + 命名 project：命名行有删除按钮，默认行（name 空）没有（review MF-1 双保险）
    store.projects = [
      makeProject(DEFAULT_PROJECT_ID, ''),
      makeProject('a', 'Alpha'),
    ]
    store.activeProjectId = 'a'
    const w2 = mount(ProjectSwitcher)
    await w2.find('[data-testid="project-switcher-current"]').trigger('click')
    const rows = w2.findAll('[data-testid="project-item"]')
    expect(rows).toHaveLength(2)
    const defaultRow = rows.find((r) => r.text().includes('默认项目'))!
    expect(defaultRow.find('[title="删除项目"]').exists()).toBe(false)
    const alphaRow = rows.find((r) => r.text().includes('Alpha'))!
    expect(alphaRow.find('[title="删除项目"]').exists()).toBe(true)
  })

  it('删除流：点 Trash → ConfirmDialog 出现（描述指向被删项）→ 确认 → removeProject 生效 + 列表消失', async () => {
    const store = useProjectStore()
    store.projects = [
      makeProject(DEFAULT_PROJECT_ID, ''),
      makeProject('a', 'Alpha'),
      makeProject('b', 'Beta'),
    ]
    store.activeProjectId = 'a'

    wrapper = mount(ProjectSwitcher, { attachTo: document.body })
    await wrapper.find('[data-testid="project-switcher-current"]').trigger('click')

    // 点 Beta 行的 Trash → ConfirmDialog 打开（teleport 到 body，描述含被删项名）
    const betaRow = wrapper
      .findAll('[data-testid="project-item"]')
      .find((r) => r.text().includes('Beta'))!
    await betaRow.find('[title="删除项目"]').trigger('click')
    await nextTick()
    expect(document.body.textContent).toContain('确认删除项目「Beta」')

    // 确认 → removeProject 生效，列表刷新后 Beta 行消失
    findDialogButton('删除')!.dispatchEvent(new MouseEvent('click'))
    await nextTick()
    expect(store.projects.some((p) => p.id === 'b')).toBe(false)
    expect(
      wrapper.findAll('[data-testid="project-item"]').some((r) => r.text().includes('Beta')),
    ).toBe(false)
  })

  it('删除流：取消不删除，ConfirmDialog 关闭', async () => {
    const store = useProjectStore()
    store.projects = [
      makeProject(DEFAULT_PROJECT_ID, ''),
      makeProject('a', 'Alpha'),
      makeProject('b', 'Beta'),
    ]
    store.activeProjectId = 'a'

    wrapper = mount(ProjectSwitcher, { attachTo: document.body })
    await wrapper.find('[data-testid="project-switcher-current"]').trigger('click')

    const betaRow = wrapper
      .findAll('[data-testid="project-item"]')
      .find((r) => r.text().includes('Beta'))!
    await betaRow.find('[title="删除项目"]').trigger('click')
    await nextTick()

    findDialogButton('取消')!.dispatchEvent(new MouseEvent('click'))
    await nextTick()
    expect(store.projects.some((p) => p.id === 'b')).toBe(true)
    // 关闭态断言：reka DialogContent data-state=closed（exit 动画依赖 transitionend，happy-dom 不触发，
    // 内容不会卸载——以 state 断言关闭语义而非 DOM 消失）
    expect(document.body.querySelector('[data-state="closed"]')).not.toBeNull()
  })

  it('删除流：删活跃项自动切首个（recentProjects 顺序首位）', async () => {
    const store = useProjectStore()
    store.projects = [
      makeProject(DEFAULT_PROJECT_ID, ''),
      makeProject('a', 'Alpha'),
      makeProject('b', 'Beta'),
    ]
    store.activeProjectId = 'a'

    wrapper = mount(ProjectSwitcher, { attachTo: document.body })
    await wrapper.find('[data-testid="project-switcher-current"]').trigger('click')

    const alphaRow = wrapper
      .findAll('[data-testid="project-item"]')
      .find((r) => r.text().includes('Alpha'))!
    await alphaRow.find('[title="删除项目"]').trigger('click')
    await nextTick()
    findDialogButton('删除')!.dispatchEvent(new MouseEvent('click'))
    await nextTick()

    expect(store.projects.some((p) => p.id === 'a')).toBe(false)
    // 删的是活跃项 → 切到列表首位（默认项目，recentProjects 排序后的第一个）
    expect(store.activeProjectId).toBe(DEFAULT_PROJECT_ID)
  })
})
