/**
 * DrawerPanel 测试（W3 · p3-strangler-domains::drawer，AC9/AC12 冒烟载体）。
 *
 * 三视角：
 * - 使用者（黑盒）：mount DrawerPanel（isOpen:true）断言 5 基础 tab 按钮 + 展开态内容区
 *   在 DOM 中存在；点关闭按钮触发 close emit（父组件消费 → isOpen=false → 收起）
 * - 构建者（白盒）：widget 数据 props 注入驱动内容区三态（gui 优先 / lines 兜底 / 空态）
 *   + unknown 徽章 + status footer + 内容面板 slot 注入替换 + 无 slot 时内置区 fallback
 * - 观察者（形态）：isOpen=false 时 aside 不渲染；hasTasksData=true 时 tasks tab 出现
 *
 * mock 策略（design-review mockStrategyNote）：零真 store——vitest.setup 已 mock vue-i18n
 * useI18n（t 返回 key，断言 DOM 结构不依赖文案）；GuiComponentRenderer/AnsiText 用真实
 * 组件（../../rendering-protocol，w6 基线已验证可渲染）；slot 注入用 template #default
 * 放 testid 占位 div。
 *
 * 运行：cd packages/ui && npx vitest run src/features/drawer/
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { DrawerPanel } from '../index'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { SideDrawerTab } from '@xyz-agent/core/domain/drawer'

/** 展开态基础 props（控制态四字段，widget 数据走默认空 → 空态分支） */
function baseProps<T extends object>(overrides: T = {} as T) {
  return {
    isOpen: true as boolean,
    activeTab: 'terminal' as SideDrawerTab,
    docked: false as boolean,
    sessionId: 's1',
    ...overrides,
  }
}

describe('DrawerPanel (AC9/AC12 首屏冒烟)', () => {
  it('展开态：5 基础 tab 按钮 + 展开态内容区 DOM 存在', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    for (const key of ['terminal', 'browser', 'git', 'doc', 'detail']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
    expect(wrapper.find('[data-testid="drawer-content"]').exists()).toBe(true)
  })

  it('关闭 emit 触发收起：点关闭按钮 → emitted close；isOpen=false 重渲染 → 收起不渲染', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    // 父组件消费 close → isOpen 置 false → drawer 收起（观察者视角，fresh mount 断言收起态）
    const collapsed = mount(DrawerPanel, { props: baseProps({ isOpen: false }) })
    expect(collapsed.find('[data-testid="drawer-panel"]').exists()).toBe(false)
  })

  it('收起态：isOpen=false 时 aside 不渲染', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ isOpen: false }) })
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
  })
})

describe('DrawerPanel (widget 内容区三分支)', () => {
  it('activeGuiComponent 优先：渲染 gui 渲染器，lines/空态不渲染', () => {
    const gui: GuiComponent = { type: 'ansi-text', props: { lines: ['hello'] } }
    const wrapper = mount(DrawerPanel, {
      props: baseProps({ activeGuiComponent: gui, activeLines: ['ignored'] }),
    })
    expect(wrapper.find('[data-testid="drawer-widget-gui"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-widget-lines"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(false)
  })

  it('activeLines 文本兜底：等宽行渲染 + unknown 徽章', () => {
    const wrapper = mount(DrawerPanel, {
      props: baseProps({ activeLines: ['line1', 'line2'], activeLinesMeta: { unknown: true, key: 'my-widget' } }),
    })
    expect(wrapper.find('[data-testid="drawer-widget-lines"]').exists()).toBe(true)
    const codes = wrapper.findAll('[data-testid="drawer-widget-lines"] code')
    expect(codes).toHaveLength(2)
    expect(wrapper.find('[data-testid="drawer-unknown-badge"]').exists()).toBe(true)
  })

  it('均空 → 空态占位（icon + emptyText/emptyHint 文案）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(true)
    // t mock 返回 key，断言空态文案 slot 存在（DOM 结构不依赖中文）
    expect(wrapper.find('[data-testid="drawer-widget-empty"] p').exists()).toBe(true)
  })
})

describe('DrawerPanel (status footer + 内容面板 slot)', () => {
  it('statusEntries 渲染 footer（statusKey + text）', () => {
    const wrapper = mount(DrawerPanel, {
      props: baseProps({ statusEntries: [{ statusKey: 'git', text: 'clean' }] }),
    })
    const footer = wrapper.find('[data-testid="drawer-status-footer"]')
    expect(footer.exists()).toBe(true)
    expect(footer.text()).toContain('git')
  })

  it('statusEntries 为空时不渲染 footer（不占位）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-status-footer"]').exists()).toBe(false)
  })

  it('内容面板 slot 注入：slot 内容替换内置 widget 区（无 fallback 双渲染）', () => {
    const wrapper = mount(DrawerPanel, {
      props: baseProps(),
      slots: { default: '<div data-testid="panel-slot" />' },
    })
    expect(wrapper.find('[data-testid="panel-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(false)
  })

  it('无 slot 时内置 widget 区作为 fallback 渲染', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(true)
  })
})

describe('DrawerPanel (tab 交互 + tasks 条件)', () => {
  it('tab 点击 emit set-tab', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-tab-browser"]').trigger('click')
    expect(wrapper.emitted('set-tab')).toEqual([['browser']])
  })

  it('钉住按钮 emit toggle-dock', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-pin"]').trigger('click')
    expect(wrapper.emitted('toggle-dock')).toHaveLength(1)
  })

  it('hasTasksData=false（默认）无 tasks tab；true 时出现', () => {
    const without = mount(DrawerPanel, { props: baseProps() })
    expect(without.find('[data-testid="drawer-tab-tasks"]').exists()).toBe(false)
    const withTasks = mount(DrawerPanel, { props: baseProps({ hasTasksData: true }) })
    expect(withTasks.find('[data-testid="drawer-tab-tasks"]').exists()).toBe(true)
  })

  it('activeTab 高亮：当前 tab 应用选中样式（bg-accent-soft）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ activeTab: 'git' }) })
    const gitTab = wrapper.find('[data-testid="drawer-tab-git"]')
    expect(gitTab.classes()).toContain('bg-accent-soft')
  })
})

describe('DrawerPanel (header-extra slot，W4 壳层挂载点)', () => {
  it('有 header-extra slot：header 内渲染注入内容（unread badge 等壳状态）', () => {
    const wrapper = mount(DrawerPanel, {
      props: baseProps(),
      slots: { 'header-extra': '<div data-testid="drawer-unread-badge">2</div>' },
    })
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').text()).toBe('2')
  })

  it('无 header-extra slot：不渲染（向后兼容，存量用例零改动）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(false)
  })
})
