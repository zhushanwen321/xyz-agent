/**
 * WidgetArea.test.ts —— M17 对话流 widget 面板单测（design.json TC1-TC6）。
 *
 * 覆盖：
 *  - TC1 首屏冒烟：list-tree 型 guiTree 经 GuiComponentRenderer 渲染原语 DOM + 卡头 widgetKey 标签
 *  - TC2 文本 widget：ansi-text 原语渲染 lines 内容
 *  - TC3 多 widgetKey 分栏：两卡并排 + grid 容器 flex/flex-wrap 布局
 *  - TC7 宽度对齐：band px-5 + grid content-col（单卡/多卡联合宽 ≤ composer）
 *  - TC8 折叠交互：点击卡头 → 卡体隐藏 + data-collapsed；再点 → 恢复展开
 *  - TC4 清除语义：mock 容器清空 → 同实例 computed 重算 → 整体零 DOM（无残留空容器）
 *  - TC5 无数据隐藏 + 无 provide 环境兜底（inject(key, null) 不崩，ES1）
 *  - TC6 空 guiTree 条目过滤（guiTree=[] 不出空卡，ES4 异常 payload 防护）
 *
 * mock 模式对齐 ViewHost.test.ts：global.provide 注入 VIEW_HOST_SOURCE_KEY +
 * reactive 容器（Map mutate 触发 WidgetArea entries computed 重算——组件在 computed
 * 内调用 getViewIds/getView 建立依赖追踪，C1 契约）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/WidgetArea.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import WidgetArea from '../WidgetArea.vue'
import {
  VIEW_HOST_SOURCE_KEY,
  type ViewHostSource,
  type ViewCacheEntry,
} from '../../../extension-host'

const SESSION = 's1'

function makeEntry(viewId: string, guiTree: GuiComponent[], meta?: ViewCacheEntry['meta']): ViewCacheEntry {
  return { viewId, pluginId: 'p1', guiTree, updatedAt: 123, ...(meta ? { meta } : {}) }
}

/**
 * 响应式 mock source：getViewIds/getView 读同一 reactive Map（对齐 ViewHost.test.ts
 * R2 的壳层响应式桥模拟）。store.views 的 get/set/delete/keys 迭代均被 Vue 追踪，
 * TC4 清除场景改 Map 即触发组件重算。
 */
function makeSource(initial: Record<string, ViewCacheEntry>) {
  const store = reactive({ views: new Map<string, ViewCacheEntry>(Object.entries(initial)) })
  const source: ViewHostSource = {
    getViewIds: vi.fn((sessionId: string) =>
      sessionId === SESSION ? [...store.views.keys()] : [],
    ),
    getView: vi.fn(
      (sessionId: string, viewId: string) =>
        sessionId === SESSION ? store.views.get(viewId) : undefined,
    ),
  }
  return { store, source }
}

function mountArea(source: ViewHostSource, sessionId: string = SESSION) {
  return mount(WidgetArea, {
    props: { sessionId },
    global: { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: source } },
  })
}

describe('WidgetArea（M17 对话流 widget 面板）', () => {
  it('TC1 首屏冒烟：list-tree guiTree 渲染原语 DOM + 卡头 widgetKey 标签', async () => {
    const { source } = makeSource({
      goal: makeEntry('goal', [
        {
          type: 'list-tree',
          props: {
            items: [
              { label: 'task-a', status: 'running' },
              { label: 'task-b', status: 'done' },
            ],
          },
        },
      ]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    // 容器 + 卡片存在
    const area = wrapper.find('[data-testid="widget-area"]')
    expect(area.exists()).toBe(true)
    const card = wrapper.find('[data-testid="widget-card"]')
    expect(card.exists()).toBe(true)

    // 卡体内 GuiComponentRenderer 真实渲染 list-tree 原语（ListTree testid 为 gui-list-tree）
    expect(card.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
    // 卡头 widgetKey 标签 + 原语 label 内容
    expect(card.text()).toContain('goal')
    expect(card.text()).toContain('task-a')
    expect(card.text()).toContain('task-b')
  })

  it('TC2 文本 widget：ansi-text 原语渲染 lines 内容', async () => {
    const { source } = makeSource({
      log: makeEntry('log', [{ type: 'ansi-text', props: { lines: ['plain text line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const card = wrapper.find('[data-testid="widget-card"]')
    expect(card.exists()).toBe(true)
    // ansi-text 原语 DOM 存在且内容含该行（lines 经 resolveComponent join 成 content）
    const ansi = card.find('[data-testid="ansi-text"]')
    expect(ansi.exists()).toBe(true)
    expect(ansi.text()).toContain('plain text line')
  })

  it('TC3 多 widgetKey 分栏：两卡并排 + grid 容器 flex/flex-wrap 布局', async () => {
    const { source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['todo line'] } }]),
      goal: makeEntry('goal', [{ type: 'ansi-text', props: { lines: ['goal line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    // grid 容器 class 含 flex + flex-wrap（多卡分栏布局）+ gap
    const gridClasses = wrapper.find('[data-testid="widget-area-grid"]').classes()
    expect(gridClasses).toContain('flex')
    expect(gridClasses).toContain('flex-wrap')
    expect(gridClasses).toContain('gap-2.5')

    // 两张卡，卡头标签分别为 todo / goal
    const cards = wrapper.findAll('[data-testid="widget-card"]')
    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('todo')
    expect(cards[1].text()).toContain('goal')
  })

  it('TC7 宽度对齐：band px-5 + grid content-col（联合宽 ≤ composer）', async () => {
    const { source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['todo line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    // 外层 band：px-5 侧距对齐 composer-band
    const areaClasses = wrapper.find('[data-testid="widget-area"]').classes()
    expect(areaClasses).toContain('px-5')

    // 内层 grid：与 Composer 相同的内容列原语（.content-col = mx-auto + w-full + max-w token，
    // 定义在 renderer style.css @layer utilities；改宽度只动 --content-max-w）
    const gridClasses = wrapper.find('[data-testid="widget-area-grid"]').classes()
    expect(gridClasses).toContain('content-col')
  })

  it('TC8 折叠交互：点击卡头收起卡体（v-show 隐藏 + data-collapsed），再点恢复', async () => {
    const { source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['todo line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const card = wrapper.find('[data-testid="widget-card"]')
    const body = wrapper.find('[data-testid="widget-card-body"]')
    const bodyStyle = () => body.attributes('style') ?? ''

    // 初始展开：卡体无 display 隐藏 + 无 collapsed 标记。
    // 直读 inline style 断言（jsdom 环境下 isVisible() 对 v-show 不可靠，实测 display:none 仍返回 true）
    expect(bodyStyle()).not.toContain('display: none')
    expect(card.attributes('data-collapsed')).toBe('false')

    // 点击卡头 → 收起：卡体隐藏（v-show，DOM 保留），卡收缩为按内容宽窄条（flex-none）
    await wrapper.find('[data-testid="widget-card-header"]').trigger('click')
    expect(bodyStyle()).toContain('display: none')
    expect(card.attributes('data-collapsed')).toBe('true')
    expect(card.classes()).toContain('flex-none')

    // 再点 → 恢复展开
    await wrapper.find('[data-testid="widget-card-header"]').trigger('click')
    expect(bodyStyle()).not.toContain('display: none')
    expect(card.attributes('data-collapsed')).toBe('false')
    expect(card.classes()).not.toContain('flex-none')
  })

  it('TC4 清除语义：mock 容器清空 → 同实例重算 → widget-area 整体消失', async () => {
    const { store, source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['todo line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()
    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="widget-card"]').exists()).toBe(true)

    // 清除（gui:null 语义 → store 层条目消失）：改 reactive Map 触发 computed 重算
    store.views.delete('todo')
    await nextTick()

    // 无数据整体隐藏，无残留空容器
    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="widget-card"]').exists()).toBe(false)
  })

  it('TC5① 无数据（getViewIds 空数组）→ 不渲染 widget-area', async () => {
    const { source } = makeSource({})
    const wrapper = mountArea(source)
    await nextTick()

    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(false)
  })

  it('TC5② 无 provide（无注入 source）→ 静默空态不抛错', () => {
    // 不 provide VIEW_HOST_SOURCE_KEY 直接 mount：inject(key, null) 兜底（ES1）
    const wrapper = mount(WidgetArea, { props: { sessionId: SESSION } })
    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(false)
  })

  it('TC6 空 guiTree 条目过滤：guiTree=[] 不出空卡', async () => {
    const { source } = makeSource({
      a: makeEntry('a', []),
      b: makeEntry('b', [{ type: 'ansi-text', props: { lines: ['b line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    // 只渲染 b 一张卡（a 的空 guiTree 被过滤，不出空卡）
    const cards = wrapper.findAll('[data-testid="widget-card"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].text()).toContain('b')
    expect(cards[0].text()).not.toContain('a')
  })

  // ── v1.1 meta head（单一 head：标题/状态点/进度/折叠）──

  it('TC9 meta head：标题用 meta.title（优先于 viewId）+ 状态点 + 进度计数/mini bar', async () => {
    const { source } = makeSource({
      todo: makeEntry(
        'todo',
        [{ type: 'list-tree', props: { numbered: true, items: [{ label: 'a', depth: 0 }] } }],
        { title: 'Todo', status: 'running', progress: { current: 1, total: 3 } },
      ),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const header = wrapper.find('[data-testid="widget-card-header"]')
    expect(header.exists()).toBe(true)
    // 标题：meta.title（"Todo" 大写形态），head 排版 mono 紧凑档
    expect(header.text()).toContain('Todo')
    // 进度计数文本（label 缺省 current/total）+ mini bar fill 存在
    expect(header.text()).toContain('1/3')
    expect(header.find('[data-testid="widget-head-progress-fill"]').exists()).toBe(true)
    // 状态点存在（running → bg-accent）
    const dot = header.find('[data-testid="widget-head-status-dot"]')
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('bg-accent')
  })

  it('TC10 meta.progress.label 覆盖计数文本；severity 映射 fill 色；done → fill 绿', async () => {
    const { source } = makeSource({
      goal: makeEntry(
        'goal',
        [{ type: 'ansi-text', props: { lines: ['x'] } }],
        { title: 'fix-auth', status: 'failed', progress: { current: 95, total: 100, label: '95%', severity: 'danger' } },
      ),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const header = wrapper.find('[data-testid="widget-card-header"]')
    expect(header.text()).toContain('95%')
    expect(header.text()).toContain('fix-auth')
    const fill = header.find('[data-testid="widget-head-progress-fill"]')
    expect(fill.classes()).toContain('bg-danger')
    // failed 状态点 → bg-danger
    expect(header.find('[data-testid="widget-head-status-dot"]').classes()).toContain('bg-danger')

    // done + 无 severity → fill 绿（success）
    const { source: s2 } = makeSource({
      todo: makeEntry(
        'todo',
        [{ type: 'ansi-text', props: { lines: ['x'] } }],
        { title: 'Todo', status: 'done', progress: { current: 3, total: 3 } },
      ),
    })
    const w2 = mountArea(s2)
    await nextTick()
    const fill2 = w2.find('[data-testid="widget-head-progress-fill"]')
    expect(fill2.classes()).toContain('bg-success')
  })

  it('TC11 无 meta（v1 旧 extension）→ head fallback viewId 标题，无进度无状态点异常', async () => {
    const { source } = makeSource({
      legacy: makeEntry('legacy', [{ type: 'ansi-text', props: { lines: ['x'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    const header = wrapper.find('[data-testid="widget-card-header"]')
    expect(header.text()).toContain('legacy')
    // 无 progress → 无计数文本/fill（状态点仍渲染，idle 弱点降级）
    expect(header.find('[data-testid="widget-head-progress-fill"]').exists()).toBe(false)
    expect(header.find('[data-testid="widget-head-status-dot"]').classes()).toContain('bg-neutral-dim')
  })

  it('TC12 卡体可选中复制（select-text）+ head 不可选中（select-none）', async () => {
    const { source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['copy me'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    // 全局 user-select:none（renderer style.css）下，卡体需显式 select-text 才可复制
    expect(wrapper.find('[data-testid="widget-card-body"]').classes()).toContain('select-text')
    expect(wrapper.find('[data-testid="widget-card-header"]').classes()).toContain('select-none')
  })

  it('TC13 底色层次：head bg-surface-2（header 浮起层）+ 卡体 bg-bg-input（composer 同款凹陷）', async () => {
    const { source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['x'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    // head 浮起 + body 凹陷的两级 bg 层次（无 border，v6 靠 bg 分组）
    expect(wrapper.find('[data-testid="widget-card-header"]').classes()).toContain('bg-surface-2')
    expect(wrapper.find('[data-testid="widget-card"]').classes()).toContain('bg-bg-input')
    // 卡壳无 border（对齐 Card 原语 v6 裁决：明度差替代边框）
    const cardClasses = wrapper.find('[data-testid="widget-card"]').classes()
    expect(cardClasses.some((c) => c.startsWith('border'))).toBe(false)
  })
})
