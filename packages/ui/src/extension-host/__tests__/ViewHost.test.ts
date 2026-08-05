/**
 * ViewHost 组件测试（W3 · T5，TC-6~TC-7）。
 *
 * 覆盖用例（design-review TC-6~TC-7，C4 契约）：
 *  - TC-6 渲染 GuiComponent 树：mock ViewHostSource 返回 ansi-text + stats-line 树，
 *    断言 GuiComponentRenderer 渲染出的 DOM 内容（AC9 view 渲染侧）
 *  - TC-7 空态占位：store 无 view 时渲染标题（title ?? viewId）+ 等待提示文案
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import ViewHost from '../ViewHost.vue'
import { VIEW_HOST_SOURCE_KEY, type ViewHostSource, type ViewCacheEntry } from '../view-host-source'

const SESSION = 's1'
const VIEW_ID = 'v1'

/** mock GuiComponent 树：ansi-text（Hello）+ stats-line（CPU 10%） */
function makeTree(): GuiComponent[] {
  return [
    { type: 'ansi-text', props: { lines: ['Hello'] } },
    { type: 'stats-line', props: { items: [{ label: 'CPU', value: '10%' }] } },
  ]
}

/** mock ViewHostSource：getView 查表（可切换 undefined/树） */
function makeStore(entry?: ViewCacheEntry) {
  const store: ViewHostSource = {
    getView: vi.fn((sessionId: string, viewId: string) => {
      if (sessionId === SESSION && viewId === VIEW_ID) return entry
      return undefined
    }),
  }
  return store
}

function mountHost(store: ViewHostSource, title?: string, empty?: 'placeholder' | 'hidden') {
  return mount(ViewHost, {
    props: { viewId: VIEW_ID, sessionId: SESSION, title, empty },
    global: {
      provide: { [VIEW_HOST_SOURCE_KEY as symbol]: store },
    },
  })
}

describe('ViewHost', () => {
  it('TC-6 渲染 GuiComponent 树：mock 树交 GuiComponentRenderer 渲染 DOM（AC9）', async () => {
    const entry: ViewCacheEntry = {
      viewId: VIEW_ID,
      pluginId: 'p1',
      guiTree: makeTree(),
      updatedAt: 123,
    }
    const store = makeStore(entry)
    const wrapper = mountHost(store)
    await wrapper.vm.$nextTick()

    // ansi-text 原语渲染 'Hello'
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Hello')
    // stats-line 原语渲染 CPU/10%
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('CPU')
    expect(wrapper.text()).toContain('10%')

    // 空态占位不渲染
    expect(wrapper.find('[data-testid="view-host-empty"]').exists()).toBe(false)
    // 按 sessionId + viewId 查询
    expect(store.getView).toHaveBeenCalledWith(SESSION, VIEW_ID)
  })

  it('TC-7 空态占位：store 无 view 时渲染标题（title 优先，缺省 fallback view-id）+ 等待提示', async () => {
    const store = makeStore(undefined)
    const wrapper = mountHost(store, '我的视图')
    await wrapper.vm.$nextTick()

    const empty = wrapper.find('[data-testid="view-host-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('我的视图')
    expect(empty.text()).toContain('等待插件渲染')
    // 无 GuiComponent 渲染
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('TC-7b 空态标题缺省：无 title prop 时 fallback view-id', async () => {
    const store = makeStore(undefined)
    const wrapper = mountHost(store)
    await wrapper.vm.$nextTick()

    const empty = wrapper.find('[data-testid="view-host-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain(VIEW_ID)
  })

  it('R2 空态 → 渲染态切换：getView 返回值变化后重渲染', async () => {
    // 可变 store：先 undefined，后注入树
    let entry: ViewCacheEntry | undefined = undefined
    const store: ViewHostSource = {
      getView: vi.fn(() => entry),
    }
    const wrapper = mountHost(store)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="view-host-empty"]').exists()).toBe(true)

    entry = { viewId: VIEW_ID, pluginId: 'p1', guiTree: makeTree(), updatedAt: 456 }
    // 重新 mount（computed 依赖注入对象，测试中通过重新渲染触发）
    const wrapper2 = mountHost(store)
    await wrapper2.vm.$nextTick()
    expect(wrapper2.find('[data-testid="view-host-empty"]').exists()).toBe(false)
    expect(wrapper2.find('[data-testid="ansi-text"]').exists()).toBe(true)
  })

  it('R3 无注入 source 时静默空态不崩', () => {
    const wrapper = mount(ViewHost, { props: { viewId: VIEW_ID, sessionId: SESSION } })
    expect(wrapper.find('[data-testid="view-host-empty"]').exists()).toBe(true)
  })

  it('TC1 empty=hidden 且无 view：组件整体零 DOM（含根节点不渲染）', async () => {
    const store = makeStore(undefined)
    const wrapper = mountHost(store, undefined, 'hidden')
    await wrapper.vm.$nextTick()

    // 零 DOM：仅剩 Vue 的 v-if 注释节点（非元素），无任何 view-host 痕迹
    expect(wrapper.html()).not.toContain('view-host')
    expect(wrapper.find('[data-testid="view-host"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="view-host-empty"]').exists()).toBe(false)
  })

  it('TC2 empty=hidden 但有 view：正常渲染 GuiComponent 树', async () => {
    const entry: ViewCacheEntry = {
      viewId: VIEW_ID,
      pluginId: 'p1',
      guiTree: makeTree(),
      updatedAt: 789,
    }
    const store = makeStore(entry)
    const wrapper = mountHost(store, undefined, 'hidden')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="view-host"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Hello')
    expect(wrapper.text()).toContain('CPU')
    expect(wrapper.find('[data-testid="view-host-empty"]').exists()).toBe(false)
  })

  it('TC3 默认 empty（不传）无 view：placeholder 占位回归', async () => {
    const store = makeStore(undefined)
    const wrapper = mountHost(store, '我的视图')
    await wrapper.vm.$nextTick()

    const empty = wrapper.find('[data-testid="view-host-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('我的视图')
    expect(empty.text()).toContain('等待插件渲染')
  })
})
