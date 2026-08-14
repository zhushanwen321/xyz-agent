/**
 * WidgetArea.test.ts —— M17 对话流 widget 面板单测（design.json TC1-TC6）。
 *
 * 覆盖：
 *  - TC1 首屏冒烟：list-tree 型 guiTree 经 GuiComponentRenderer 渲染原语 DOM + 卡头 widgetKey 标签
 *  - TC2 文本 widget：ansi-text 原语渲染 lines 内容
 *  - TC3 多 widgetKey 分栏：两卡并排 + 容器 flex/flex-wrap 布局
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

function makeEntry(viewId: string, guiTree: GuiComponent[]): ViewCacheEntry {
  return { viewId, pluginId: 'p1', guiTree, updatedAt: 123 }
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

  it('TC3 多 widgetKey 分栏：两卡并排 + 容器 flex/flex-wrap 布局', async () => {
    const { source } = makeSource({
      todo: makeEntry('todo', [{ type: 'ansi-text', props: { lines: ['todo line'] } }]),
      goal: makeEntry('goal', [{ type: 'ansi-text', props: { lines: ['goal line'] } }]),
    })
    const wrapper = mountArea(source)
    await nextTick()

    // 容器 class 含 flex + flex-wrap（多卡分栏布局）+ gap
    const areaClasses = wrapper.find('[data-testid="widget-area"]').classes()
    expect(areaClasses).toContain('flex')
    expect(areaClasses).toContain('flex-wrap')
    expect(areaClasses).toContain('gap-2.5')

    // 两张卡，卡头标签分别为 todo / goal
    const cards = wrapper.findAll('[data-testid="widget-card"]')
    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('todo')
    expect(cards[1].text()).toContain('goal')
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
})
