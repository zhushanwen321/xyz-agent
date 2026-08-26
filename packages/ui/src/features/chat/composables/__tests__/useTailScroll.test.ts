/**
 * useTailScroll composable 单测（W4 双轴尾部追踪）。
 *
 * 覆盖 U11：
 * - scrollLeft 钉右逻辑分支（scrollWidth > clientWidth 时 scrollLeft = scrollWidth）
 * - translateY 计算（N 行 → translateY(-(N-1)*lineHeight)）
 * - disableScroll 降级分支（无 transform、无 rAF DOM 操作）
 * - 未挂载防御（元素不存在时跳过，不抛异常）
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/composables/__tests__/useTailScroll.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref, computed, nextTick } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { useTailScroll, type UseTailScrollOptions } from '../useTailScroll'

// ── rAF 手动队列（同 MarkdownRenderer.test.ts 模式）──
const rafQueue: FrameRequestCallback[] = []
const originalRAF = globalThis.requestAnimationFrame
const originalCAF = globalThis.cancelAnimationFrame
beforeEach(() => {
  rafQueue.length = 0
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF
  globalThis.cancelAnimationFrame = originalCAF
  vi.restoreAllMocks()
})

async function flushRaf(): Promise<void> {
  // Drain all queued rAF callbacks (nested callbacks may enqueue more)
  while (rafQueue.length > 0) {
    const cbs = [...rafQueue]
    rafQueue.length = 0
    for (const cb of cbs) cb(0)
  }
  await nextTick()
}

/**
 * 创建测试组件：使用 useTailScroll 并暴露内部状态供断言。
 */
function createTestComponent(disableScroll = false, lineHeight = 20) {
  return defineComponent({
    props: {
      lines: { type: Array as () => string[], required: true },
    },
    setup(props) {
      const viewportRef = ref<HTMLElement>()
      const rawLines = computed(() => props.lines) as unknown as ComputedRef<string[]>
      const result = useTailScroll(rawLines, {
        viewportRef,
        disableScroll,
        lineHeight,
      })
      return {
        viewportRef,
        displayLines: result.displayLines,
        contentStyle: result.contentStyle,
      }
    },
    template: `
      <div ref="viewportRef" style="width:100px;overflow:hidden;">
        <div :style="contentStyle">
          <div v-for="(line, i) in displayLines" :key="i">{{ line }}</div>
        </div>
      </div>
    `,
  })
}

describe('useTailScroll U11', () => {
  describe('scrollLeft 钉右逻辑', () => {
    it('scrollWidth > clientWidth 时 scrollLeft 被设为 scrollWidth', async () => {
      // 直接测试 composable 的 rAF 行为（mock 元素，不挂载 DOM）
      const rawLines = ref(['short', 'a very long line'])
      const viewportRef = ref<HTMLElement>()

      // 创建 mock 元素，可控 scrollWidth/clientWidth
      const scrollLeftSetter = vi.fn()
      const mockViewport = {
        scrollWidth: 200,
        clientWidth: 100,
        scrollLeft: 0,
      } as unknown as HTMLElement
      Object.defineProperty(mockViewport, 'scrollLeft', { set: scrollLeftSetter, get: () => 0, configurable: true })

      viewportRef.value = mockViewport

      useTailScroll(rawLines, { viewportRef })

      // 触发 watch（flush: 'post' 需多次 nextTick 才能落定）
      rawLines.value = ['new', 'new very long line']
      // flush: 'post' watcher 排入微任务后需 await nextTick 落定
      await nextTick()
      // watch 回调内 nextTick + rAF 需再 flush
      await flushRaf()
      // 嵌套 nextTick 可能还需一轮
      await flushRaf()

      expect(scrollLeftSetter).toHaveBeenCalledWith(200)
    })

    it('scrollWidth <= clientWidth 时 scrollLeft 不变', async () => {
      const rawLines = ref(['short'])
      const viewportRef = ref<HTMLElement>()

      const scrollLeftSetter = vi.fn()
      const mockViewport = {
        scrollWidth: 50,
        clientWidth: 100,
        scrollLeft: 0,
      } as unknown as HTMLElement
      Object.defineProperty(mockViewport, 'scrollLeft', { set: scrollLeftSetter, get: () => 0, configurable: true })

      viewportRef.value = mockViewport

      useTailScroll(rawLines, { viewportRef })

      rawLines.value = ['still short']
      await nextTick()
      await flushRaf()

      expect(scrollLeftSetter).not.toHaveBeenCalled()
    })
  })

  describe('translateY 计算', () => {
    it('1 行无 transform', () => {
      const TestComp = createTestComponent()
      const wrapper = mount(TestComp, { props: { lines: ['only'] } })
      expect(wrapper.vm.contentStyle).toEqual({})
    })

    it('N 行 → translateY(-(N-1)*lineHeight)', () => {
      const TestComp = createTestComponent(false, 20)
      const wrapper = mount(TestComp, { props: { lines: ['a', 'b', 'c'] } })
      const style = wrapper.vm.contentStyle
      expect(style.transform).toBe('translateY(-40px)') // (3-1)*20 = 40
      expect(style.transition).toContain('transform')
    })

    it('lineHeight 自定义', () => {
      const TestComp = createTestComponent(false, 24)
      const wrapper = mount(TestComp, { props: { lines: ['a', 'b'] } })
      expect(wrapper.vm.contentStyle.transform).toBe('translateY(-24px)') // (2-1)*24 = 24
    })
  })

  describe('disableScroll 降级', () => {
    it('disableScroll=true 时无 transform', () => {
      const TestComp = createTestComponent(true)
      const wrapper = mount(TestComp, { props: { lines: ['a', 'b', 'c'] } })
      expect(wrapper.vm.contentStyle).toEqual({})
    })

    it('disableScroll=true 时不触发 rAF DOM 操作', async () => {
      const TestComp = createTestComponent(true)
      const wrapper = mount(TestComp, { props: { lines: ['a', 'b'] } })
      const viewport = wrapper.vm.viewportRef!
      const scrollLeftSpy = vi.fn()
      Object.defineProperty(viewport, 'scrollLeft', { set: scrollLeftSpy, get: () => 0, configurable: true })

      await wrapper.setProps({ lines: ['a', 'b', 'c'] })
      await flushRaf()

      expect(scrollLeftSpy).not.toHaveBeenCalled()
    })
  })

  describe('未挂载防御', () => {
    it('元素不存在时不抛异常', async () => {
      const rawLines = ref(['a', 'b'])
      const viewportRef = ref<HTMLElement>()
      // 元素未挂载（ref 为 undefined）
      expect(() => {
        useTailScroll(rawLines, { viewportRef })
      }).not.toThrow()
    })

    it('元素不存在时 rAF 不抛', async () => {
      const rawLines = ref(['a', 'b'])
      const viewportRef = ref<HTMLElement>()
      useTailScroll(rawLines, { viewportRef })

      rawLines.value = ['a', 'b', 'c']
      await nextTick()
      expect(async () => {
        await flushRaf()
      }).not.toThrow()
    })
  })
})
