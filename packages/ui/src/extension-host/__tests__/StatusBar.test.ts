/**
 * StatusBar 组件测试（W3 · T4，TC-1~TC-5）。
 *
 * 覆盖用例（design-review TC-1~TC-5，C3 契约）：
 *  - TC-1 两 scope 渲染：per-session 2 项在前 + global 1 项在后，内容与顺序正确（AC5）
 *  - TC-2 无状态项自隐藏：text 空串项不渲染
 *  - TC-3 全空自隐藏：两 scope 均无渲染项时根元素 v-if 隐藏
 *  - TC-4 commandId 项点击触发 onCommand（注入 executor）
 *  - TC-5 无 commandId 项点击无副作用
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusBar from '../StatusBar.vue'
import { STATUS_BAR_SOURCE_KEY, type StatusBarSource, type StatusBarEntry } from '../status-bar-source'

const SESSION = 's1'

/** per-session 2 项 + global 1 项（TC-1 数据）：A(left) B(right+commandId) + G(left) */
function makeItems(): {
  perSession: StatusBarEntry[]
  global: StatusBarEntry[]
} {
  return {
    perSession: [
      { id: 'p1-a', pluginId: 'p1', text: 'A', alignment: 'left', priority: 0 },
      { id: 'p1-b', pluginId: 'p1', text: 'B', alignment: 'right', priority: 1, commandId: 'cmd-b' },
    ],
    global: [{ id: 'g1', pluginId: 'p2', text: 'G', alignment: 'left', priority: 0 }],
  }
}

/** mock StatusBarSource：getItems 按 scope/sessionId 查表 */
function makeSource(overrides?: Partial<StatusBarSource>) {
  const items = makeItems()
  const source: StatusBarSource = {
    getItems: vi.fn((scope: 'per-session' | 'global', sessionId?: string) => {
      if (scope === 'per-session') return items.perSession
      return items.global
    }),
    ...overrides,
  }
  return { source, items }
}

function mountBar(source: StatusBarSource, onCommand?: (commandId: string) => void, sessionId: string | null = SESSION) {
  return mount(StatusBar, {
    props: { sessionId, onCommand },
    global: {
      provide: { [STATUS_BAR_SOURCE_KEY as symbol]: source },
    },
  })
}

describe('StatusBar', () => {
  it('TC-1 两 scope 渲染：per-session 2 项在前 + global 1 项在后，内容与顺序正确（AC5）', async () => {
    const { source } = makeSource()
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    // 根元素存在 + 3 项
    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(true)
    const items = wrapper.findAll('[data-testid="status-bar-item"]')
    expect(items).toHaveLength(3)

    // 渲染顺序：A → B → G（per-session 在前 global 在后）
    expect(items[0]!.text()).toBe('A')
    expect(items[1]!.text()).toBe('B')
    expect(items[2]!.text()).toBe('G')

    // per-session scope 用当前 sessionId 查询
    expect(source.getItems).toHaveBeenCalledWith('per-session', SESSION)
    expect(source.getItems).toHaveBeenCalledWith('global')

    // alignment=right 的项带右推 class
    expect(items[1]!.classes()).toContain('ml-auto')
    expect(items[0]!.classes()).not.toContain('ml-auto')
  })

  it('TC-2 无状态项自隐藏：text 空串项不渲染', async () => {
    const { source } = makeSource({
      getItems: (scope: 'per-session' | 'global') => {
        if (scope === 'per-session') {
          return [
            { id: 'empty', pluginId: 'p1', text: '', alignment: 'left', priority: 0 },
            { id: 'blank', pluginId: 'p1', text: '   ', alignment: 'left', priority: 0 },
            { id: 'ok', pluginId: 'p1', text: 'OK', alignment: 'left', priority: 0 },
          ]
        }
        return []
      },
    })
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    const items = wrapper.findAll('[data-testid="status-bar-item"]')
    expect(items).toHaveLength(1)
    expect(items[0]!.text()).toBe('OK')
  })

  it('TC-3 全空自隐藏：两 scope 均无渲染项时根元素 v-if 隐藏', async () => {
    const { source } = makeSource({
      getItems: () => [],
    })
    const wrapper = mountBar(source)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(false)
  })

  it('TC-4 commandId 项点击触发 onCommand（注入 executor）', async () => {
    const { source } = makeSource()
    const onCommand = vi.fn()
    const wrapper = mountBar(source, onCommand)
    await wrapper.vm.$nextTick()

    const items = wrapper.findAll('[data-testid="status-bar-item"]')
    await items[1]!.trigger('click') // B 项 commandId='cmd-b'

    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledWith('cmd-b')
  })

  it('TC-5 无 commandId 项点击无副作用', async () => {
    const { source } = makeSource()
    const onCommand = vi.fn()
    const wrapper = mountBar(source, onCommand)
    await wrapper.vm.$nextTick()

    const items = wrapper.findAll('[data-testid="status-bar-item"]')
    await items[0]!.trigger('click') // A 项无 commandId
    await items[2]!.trigger('click') // G 项无 commandId

    expect(onCommand).not.toHaveBeenCalled()
  })

  it('R3 无注入 source 时静默空态不崩', () => {
    const wrapper = mount(StatusBar, { props: { sessionId: SESSION } })
    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(false)
  })
})
