/**
 * CW wave `trace-tokenize-wave`：useTraceTransition 高度过渡 token 化回归测试。
 *
 * 覆盖（TC1-3，对应 wave design testCases）：
 * - TC1：--duration/--ease 读不到（CSS 未加载）→ fallback 200ms + 'ease-out'（保持现状行为）
 * - TC2：--duration/--ease 有值 → 使用 token 值（200ms + cubic-bezier(0.4,0,0.2,1)）
 * - TC3：onTraceLeave 的 transition 字符串与 setTimeout 兜底时长同源（同一模块级变量）
 *
 * mock 时序关键：TRACE_TRANSITION_MS/TRACE_EASING 是模块级变量，在模块加载时求值——
 * 必须 import 前 vi.stubGlobal getComputedStyle，再 vi.resetModules + 动态 import 使模块级变量生效。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useStickGuard.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

/** stub getComputedStyle 返回指定 CSS 变量表；必须在 import 模块前调用 */
function stubComputedStyle(vars: Record<string, string>): void {
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => vars[name] ?? '',
  }))
}

/** resetModules + 动态 import，让模块级 token 变量按当前 stub 重新求值 */
async function loadModule() {
  vi.resetModules()
  return await import('@/composables/panel/useStickGuard')
}

function makeElement(): HTMLElement {
  const el = document.createElement('div')
  // happy-dom 无真实布局，scrollHeight 为 0；高度断言只看 transition 字符串与 setTimeout 时长
  return el
}

describe('useTraceTransition token 化', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('TC1: --duration/--ease 读不到时 fallback 200ms + ease-out，setTimeout 兜底时长一致', async () => {
    stubComputedStyle({})
    const { useTraceTransition } = await loadModule()
    const { onTraceEnter } = useTraceTransition(null)
    const el = makeElement()
    const done = vi.fn()
    vi.useFakeTimers()

    onTraceEnter(el, done)

    // transition 字符串 fallback：200ms + ease-out（保持现状行为）
    expect(el.style.transition).toBe('height 200ms ease-out')
    // setTimeout 兜底时长与 transition 同源（模块级变量驱动）
    vi.advanceTimersByTime(200)
    expect(done).toHaveBeenCalledTimes(1)
    // 兜底完成后清理 inline style
    expect(el.style.height).toBe('')
    expect(el.style.transition).toBe('')
  })

  it('TC2: --duration/--ease 有值时使用 token 值', async () => {
    stubComputedStyle({
      '--duration': '200ms',
      '--ease': 'cubic-bezier(0.4, 0, 0.2, 1)',
    })
    const { useTraceTransition } = await loadModule()
    const { onTraceEnter } = useTraceTransition(null)
    const el = makeElement()
    const done = vi.fn()
    vi.useFakeTimers()

    onTraceEnter(el, done)

    expect(el.style.transition).toBe('height 200ms cubic-bezier(0.4, 0, 0.2, 1)')
    vi.advanceTimersByTime(200)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('TC3: onTraceLeave 的 transition 字符串与 setTimeout 兜底时长同源一致', async () => {
    stubComputedStyle({
      '--duration': '200ms',
      '--ease': 'cubic-bezier(0.4, 0, 0.2, 1)',
    })
    const { useTraceTransition } = await loadModule()
    const { onTraceLeave } = useTraceTransition(null)
    const el = makeElement()
    const done = vi.fn()
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')

    onTraceLeave(el, done)

    // transition 字符串与 setTimeout 兜底引用同一模块级变量（强绑定）
    expect(el.style.transition).toBe('height 200ms cubic-bezier(0.4, 0, 0.2, 1)')
    const calls = setTimeoutSpy.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    // 兜底时长与 transition 字符串中的 ms 一致（200）
    expect(calls[0][1]).toBe(200)
  })
})
