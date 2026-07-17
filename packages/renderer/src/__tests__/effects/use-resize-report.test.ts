/**
 * useResizeReport 单测 —— Turn 高度测量上报基建（W2）。
 *
 * 测的是真行为，不是凑覆盖率：
 * - SR7 provide/inject：Turn 挂载后 RO 触发 → registry.reportHeight 被调（key + height 正确）
 * - 优雅降级：无 registry provide 时 no-op（不抛错、不创建 RO）
 * - SR8 ε 阈值：高度变化 <1px 不上报（防亚像素抖动死循环）
 * - SR8 同帧合并：一次 RO 回调多 entry 取最后一个（防御性，单元素理论上只 1 entry）
 * - SR9 disconnect：卸载后 RO.disconnect 被调（不再上报）+ unregister 被调
 * - 首次测量必报（无基准时忽略 ε）
 *
 * ── 测试基建 ────────────────────────────────────────────────────
 * inject 只能在组件 setup 作用域生效，故用 @vue/test-utils 挂载一个包装组件：
 *   <Provider>（provideTurnResizeRegistry）→ <TurnHost>（调 useResizeReport）
 * Provider 持有 mock registry（捕获 reportHeight/unregister 调用），
 * TurnHost 暴露 rootEl ref + 触发 RO 回调的入口（通过 ref 拿到组件实例）。
 *
 * happy-dom 不提供 ResizeObserver，必须 stub——本测需要可控触发回调（不像
 * useChatScroll 那样纯 no-op），故 MockResizeObserver 捕获 callback 供测试显式调用。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-resize-report.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import {
  provideTurnResizeRegistry,
  useResizeReport,
  type TurnResizeRegistry,
} from '@/composables/effects/useResizeReport'

// ── MockResizeObserver：捕获 callback 供测试显式触发 ───────────────

interface MockROInstance {
  callback: ResizeObserverCallback
  target: Element | null
  disconnected: boolean
  observe: (target: Element) => void
  unobserve: () => void
  disconnect: () => void
}

/** 当前活跃的 MockResizeObserver 实例（最后 observe 的那个）。测试通过它触发回调 */
let activeRO: MockROInstance | null = null
/** 记录所有 disconnect 调用过的实例，验证卸载行为 */
let allROInstances: MockROInstance[] = []

/**
 * MockResizeObserver：捕获 callback 供测试显式触发。
 *
 * 工厂函数（被 `new` 调用时返回 plain object，方法用闭包持有状态，
 * 不依赖 `this`）。被 stubGlobal 注入后，被测代码 `new ResizeObserver(cb)`
 * 拿到本函数返回的对象。
 */
function MockResizeObserver(cb: ResizeObserverCallback): MockROInstance {
  // 闭包持有实例状态（observe 设置，disconnect 读取），无需 this
  let target: Element | null = null
  let disconnected = false
  const instance: MockROInstance = {
    callback: cb,
    get target(): Element | null {
      return target
    },
    get disconnected(): boolean {
      return disconnected
    },
    observe(t: Element): void {
      target = t
      activeRO = instance
    },
    unobserve(): void {
      // 单测不模拟 unobserve（useResizeReport 用 disconnect 统一清理）
    },
    disconnect(): void {
      disconnected = true
      if (activeRO === instance) activeRO = null
    },
  }
  allROInstances.push(instance)
  return instance
}

beforeEach(() => {
  activeRO = null
  allROInstances = []
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
  activeRO = null
  allROInstances = []
})

/** 构造一个 ResizeObserverEntry（contentRect.height = h） */
function mockEntry(target: Element, height: number): ResizeObserverEntry {
  return {
    target,
    contentRect: {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width: 100,
      height,
      right: 100,
      bottom: height,
      toJSON: () => ({}),
    },
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  } as unknown as ResizeObserverEntry
}

/** 触发当前活跃 RO 的回调（模拟元素高度变化） */
function fireRO(target: Element, heights: number[]): void {
  if (!activeRO) throw new Error('fireRO: 无活跃 MockResizeObserver（observe 未被调用？）')
  const entries = heights.map((h) => mockEntry(target, h))
  activeRO.callback(entries, activeRO as unknown as ResizeObserver)
}

// ── 包装组件 ────────────────────────────────────────────────────

/** mock registry：捕获 reportHeight / unregister 调用，供断言 */
function makeMockRegistry(): TurnResizeRegistry & {
  reports: Array<{ key: string; h: number }>
  unregisters: string[]
} {
  const reports: Array<{ key: string; h: number }> = []
  const unregisters: string[] = []
  return {
    reportHeight: (key: string, h: number) => {
      reports.push({ key, h })
    },
    unregister: (key: string) => {
      unregisters.push(key)
    },
    reports,
    unregisters,
  }
}

/**
 * 构造 Provider → TurnHost 组件树（闭包捕获 mock registry 与 turnKey ref）。
 * 每个用例独立创建（而非共享工厂）保证 mock 间隔离。
 */
function makeProviderTree(mock: TurnResizeRegistry, turnKey: { value: string }) {
  return defineComponent({
    name: 'TestProvider',
    setup() {
      provideTurnResizeRegistry(mock)
      const TurnHost = defineComponent({
        name: 'TurnHost',
        setup() {
          const rootEl = ref<HTMLElement | null>(null)
          useResizeReport(rootEl, () => turnKey.value)
          return () => h('div', { class: 'turn-host', ref: rootEl })
        },
      })
      return () => h(TurnHost)
    },
  })
}

// ── 测试用例 ────────────────────────────────────────────────────

describe('useResizeReport · 挂载与上报（SR7 provide/inject）', () => {
  it('挂载后 RO 触发 → registry.reportHeight 被调用（key + height 正确）', async () => {
    const turnKey = { value: 'turn-1' }
    const mock = makeMockRegistry()
    const wrapper = mount(makeProviderTree(mock, turnKey))
    // template ref + immediate watch 在 mount 后下一 tick 才绑定 rootEl 并创建 RO
    await nextTick()

    const el = wrapper.find('.turn-host').element
    // 高度 200（首次测量）→ 必报
    fireRO(el, [200])

    expect(mock.reports).toHaveLength(1)
    expect(mock.reports[0]).toEqual({ key: 'turn-1', h: 200 })
    wrapper.unmount()
  })

  it('优雅降级：无 registry provide 时 no-op（不抛错、不创建 RO）', () => {
    // TurnHost 直接挂载（无 Provider）→ inject 拿到 null → no-op
    const turnKey = { value: 'turn-x' }
    const TurnHost = defineComponent({
      name: 'TurnHost',
      setup() {
        const rootEl = ref<HTMLElement | null>(null)
        useResizeReport(rootEl, () => turnKey.value)
        return () => h('div', { class: 'turn-host', ref: rootEl })
      },
    })
    const wrapper = mount(TurnHost)

    // 无 RO 实例被创建（inject 降级前就 return 了）
    expect(allROInstances).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('useResizeReport · ε 阈值防死循环（SR8）', () => {
  it('高度变化 <1px 不上报（亚像素抖动忽略）', async () => {
    const turnKey = { value: 'turn-2' }
    const mock = makeMockRegistry()
    const wrapper = mount(makeProviderTree(mock, turnKey))
    await nextTick()
    const el = wrapper.find('.turn-host').element

    // 首次测量 100 → 报
    fireRO(el, [100])
    expect(mock.reports).toHaveLength(1)
    expect(mock.reports[0]!.h).toBe(100)

    // 抖动 100 → 100.4（<1px）→ 不报
    fireRO(el, [100.4])
    expect(mock.reports).toHaveLength(1)

    // 抖动 100.4 → 100.6（仍 <1px 相对上次上报值 100）→ 不报
    fireRO(el, [100.6])
    expect(mock.reports).toHaveLength(1)

    // 真实变化 100 → 102（>1px）→ 报
    fireRO(el, [102])
    expect(mock.reports).toHaveLength(2)
    expect(mock.reports[1]!.h).toBe(102)

    wrapper.unmount()
  })

  it('首次测量必报（无基准时不受 ε 限制）', async () => {
    const turnKey = { value: 'turn-3' }
    const mock = makeMockRegistry()
    const wrapper = mount(makeProviderTree(mock, turnKey))
    await nextTick()
    const el = wrapper.find('.turn-host').element

    // 首次测量任意高度（哪怕很小）都应上报——让估算值尽快被实测替换
    fireRO(el, [50.5])
    expect(mock.reports).toHaveLength(1)
    expect(mock.reports[0]).toEqual({ key: 'turn-3', h: 50.5 })
    wrapper.unmount()
  })
})

describe('useResizeReport · 同帧多 entry 合并（SR8）', () => {
  it('一次 RO 回调多 entry → 取最后一个高度上报（仅上报 1 次）', async () => {
    const turnKey = { value: 'turn-4' }
    const mock = makeMockRegistry()
    const wrapper = mount(makeProviderTree(mock, turnKey))
    await nextTick()
    const el = wrapper.find('.turn-host').element

    // 同一次回调里带 3 个 entry（高度 100 / 110 / 120）——防御性场景，
    // 单元素 observe 理论上只 1 entry，但合并逻辑应取最后一个
    fireRO(el, [100, 110, 120])

    // 只应上报 1 次（合并），且高度是最后一个 entry 的 120
    expect(mock.reports).toHaveLength(1)
    expect(mock.reports[0]).toEqual({ key: 'turn-4', h: 120 })
    wrapper.unmount()
  })
})

describe('useResizeReport · RO disconnect 防泄漏（SR9）', () => {
  it('卸载后 RO.disconnect 被调用（不再上报）', async () => {
    const turnKey = { value: 'turn-5' }
    const mock = makeMockRegistry()
    const wrapper = mount(makeProviderTree(mock, turnKey))
    await nextTick()
    const el = wrapper.find('.turn-host').element

    // 挂载态正常上报
    fireRO(el, [100])
    expect(mock.reports).toHaveLength(1)

    // 卸载
    wrapper.unmount()

    // RO 已 disconnect：activeRO 被清空（disconnect 内置空）
    expect(activeRO).toBeNull()
    // 所有实例都被 disconnect
    expect(allROInstances.every((ro) => ro.disconnected)).toBe(true)

    // 再次触发（模拟卸载后的延迟回调）不应上报——activeRO 为 null，无法 fireRO
    // 此处验证语义：reportHeight 调用次数未增加
    expect(mock.reports).toHaveLength(1)
  })

  it('卸载后 registry.unregister 被调用（key 正确）', () => {
    const turnKey = { value: 'turn-6' }
    const mock = makeMockRegistry()
    const wrapper = mount(makeProviderTree(mock, turnKey))

    expect(mock.unregisters).toHaveLength(0)
    wrapper.unmount()
    expect(mock.unregisters).toEqual(['turn-6'])
  })

  it('registry 未提供 unregister 时卸载不报错（可选方法）', () => {
    const turnKey = { value: 'turn-7' }
    // 不提供 unregister 的 registry
    const minimalRegistry: TurnResizeRegistry = {
      reportHeight: vi.fn(),
    }
    const wrapper = mount(makeProviderTree(minimalRegistry, turnKey))
    // 卸载不应抛错（unregister 为 undefined 时跳过）
    expect(() => wrapper.unmount()).not.toThrow()
  })
})
