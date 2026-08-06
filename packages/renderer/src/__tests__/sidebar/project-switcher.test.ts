/**
 * ProjectSwitcher 组件测试：默认展开 + 最近使用排序 + 超过 5 个滚动。
 *
 * 对应 wave:sidebar-project-default-expand 的 tc-default-expanded-no-toggle /
 * tc-render-recent-order / tc-overflow-scroll-when-over-5。
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

describe('ProjectSwitcher: 默认展开 + 最近使用排序 + 滚动', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('xyz-agent:projects')
  })

  // ── tc-default-expanded-no-toggle ─────────────────────────
  it('首屏默认展开：列表项直接可见（无需点 toggle），active project 作为列表项之一显示', () => {
    const store = useProjectStore()
    store.projects = [makeProject('a', 'Alpha'), makeProject('b', 'Beta')]
    store.activeProjectId = 'a'

    const wrapper = mount(ProjectSwitcher)

    // 列表项在初始 mount 就存在（默认展开，非折叠下拉）
    const items = wrapper.findAll('[data-testid="project-item"]')
    expect(items.length).toBe(2)
    // active 'Alpha' 与 'Beta' 都作为列表项显示（不是独立折叠态行）
    expect(items.some((w) => w.text().includes('Alpha'))).toBe(true)
    expect(items.some((w) => w.text().includes('Beta'))).toBe(true)
  })

  // ── tc-render-recent-order ────────────────────────────────
  it('列表渲染顺序跟随 recentProjects（activeProject 第一 + 其余 lastUsedAt 降序）', () => {
    const store = useProjectStore()
    // 数组顺序 [A, B, C]，但 lastUsedAt 让 recentProjects = [A, C, B]
    store.projects = [
      makeProject('a', 'A', 300),
      makeProject('b', 'B', 100),
      makeProject('c', 'C', 200),
    ]
    store.activeProjectId = 'a'

    const wrapper = mount(ProjectSwitcher)
    const names = wrapper.findAll('[data-testid="project-item"]').map((w) => w.text())

    expect(names).toEqual(['A', 'C', 'B'])
  })

  // ── tc-overflow-scroll-when-over-5 ────────────────────────
  it('超过 5 个 project 时列表容器可滚动（max-h + overflow-y-auto）', () => {
    const store = useProjectStore()
    store.projects = Array.from({ length: 8 }, (_, i) =>
      makeProject(`p${i}`, `Proj-${i}`, i),
    )
    store.activeProjectId = 'p0'

    const wrapper = mount(ProjectSwitcher)
    const list = wrapper.find('[data-testid="project-list"]')

    expect(list.exists()).toBe(true)
    // 滚动机制：overflow-y-auto class（happy-dom 不做真实布局，用 class 断言）
    expect(list.classes()).toContain('overflow-y-auto')
    // 高度限制：含 max-h-* class（限定可视区约 5 项）
    expect(list.classes().some((c) => c.startsWith('max-h-'))).toBe(true)
    // 8 项全部渲染在列表中（滚动可见，非隐藏）
    expect(list.findAll('[data-testid="project-item"]').length).toBe(8)
  })
})
