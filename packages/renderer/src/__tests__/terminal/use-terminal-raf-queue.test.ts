/**
 * D-6.1 终端 rAF 写队列测试（W14，2026-08 perf）。
 *
 * 验收锚点（plan.md W14 / 09-panel-layer.md §3.3.1）：
 * - 同一帧内 N 个 chunk 只触发一次 xterm.write（合并块）
 * - scrollback 累积语义与改造前等价（逐 chunk 粒度、总内容一致、上限裁剪）
 * - 回放语义：sessionId 切换重挂 xterm 后回放完整
 * - E6-a：rAF 被节流时 outputQueue 超限合并不丢弃；E6-c：任何分支不丢内容
 *
 * 两层被测：
 * - Part 1 useTerminal 层（宿主组件模式，同 use-terminal.test.ts）
 * - Part 2 TerminalView 组件级（真 useTerminal + mock xterm，端到端 data→rAF→watch→write）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/use-terminal-raf-queue.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@xyz-agent/shared'
import type { UseTerminalReturn } from '@/composables/features/terminal/useTerminal'

// ── mock terminalApi（隔离 RPC；Part 2 的 TerminalView spawn 也会调）────────
const terminalApiMock = vi.hoisted(() => ({
  spawn: vi.fn(() => Promise.resolve()),
  write: vi.fn(() => Promise.resolve()),
  resize: vi.fn(() => Promise.resolve()),
  kill: vi.fn(() => Promise.resolve()),
  attach: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/api/domains/terminal', () => ({
  terminalApi: terminalApiMock,
}))

// ── mock xterm + addons（happy-dom 无 canvas；记录每次 new 的实例供断言）────
const xtermInstances = vi.hoisted(() => [] as Array<{ write: ReturnType<typeof vi.fn> }>)
function createMockTerminal() {
  const instance = {
    onData: vi.fn(),
    onResize: vi.fn(),
    onSelectionChange: vi.fn(),
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    getSelection: vi.fn(() => ''),
    getSelectionPosition: vi.fn(() => ({ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } })),
    unicode: { activeVersion: '6' },
  }
  xtermInstances.push(instance)
  return instance
}
vi.mock('@xterm/xterm', () => ({
  Terminal: function MockTerminal() { return createMockTerminal() },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function MockFitAddon() {
    return { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: function M() { return {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: function M() { return {} } }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: function M() { return {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// ── mock session store（TerminalView 的 getSessionCwd 依赖）────────────────
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    list: [{ id: 's1', cwd: '/tmp/s1' }, { id: 's2', cwd: '/tmp/s2' }],
  }),
}))

import { useTerminal } from '@/composables/features/terminal/useTerminal'
import TerminalView from '@/components/panel/TerminalView.vue'
import { dispatchSession } from '@/api/events'

// happy-dom 无 ResizeObserver（TerminalView 依赖），polyfill
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  MockResizeObserver as unknown as typeof ResizeObserver

// ── 工具 ───────────────────────────────────────────────────────────────────
let msgSeq = 0
/** 构造 terminal.data 广播消息（形状同 runtime broadcast）。 */
function makeDataMsg(sid: string, data: string): ServerMessage<'terminal.data'> {
  msgSeq += 1
  return { id: `msg-${msgSeq}`, type: 'terminal.data', payload: { sessionId: sid, data } }
}

/** 测试宿主组件：在 setup 内调 useTerminal（useSessionEvents 要求），expose 返回值。 */
function makeHost(sessionId: string | null) {
  return defineComponent({
    setup() {
      const sidRef = ref(sessionId)
      const terminal = useTerminal(sidRef)
      return { terminal, sidRef }
    },
    render: () => h('div'),
  })
}

/** 推进一帧（16ms）触发 pending 的 rAF 回调。 */
function advanceFrame(): void {
  vi.advanceTimersByTime(16)
}

let wrappers: Array<ReturnType<typeof mount>> = []

beforeEach(() => {
  setActivePinia(createPinia())
  // 只 fake rAF：Vue 的响应式调度（microtask）保持真实，watch 触发走 flushPromises
  vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
  msgSeq = 0
  xtermInstances.length = 0
  terminalApiMock.spawn.mockClear()
  terminalApiMock.write.mockClear()
  terminalApiMock.attach.mockClear()
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  vi.useRealTimers()
})

// ── Part 1：useTerminal 层（appendChunk / flushPending / E6-a）──────────────
describe('D-6.1 rAF 写队列（useTerminal 层）', () => {
  it('RQ-1: N 条 terminal.data 同帧只入 outputQueue，rAF 后逐 chunk 进 scrollback（粒度+总内容等价）', () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn

    const chunks = ['hel', 'lo ', 'wor', 'ld\n', 'line2\n']
    for (const c of chunks) dispatchSession('s1', makeDataMsg('s1', c))

    // flush 前：scrollback 未动（改造前是逐条立即可见，改造后延迟到帧边界）
    expect(terminal.current.value.scrollback).toEqual([])
    expect(terminal.current.value.outputQueue).toEqual(chunks)

    advanceFrame()
    // flush 后：逐 chunk push（保持回放粒度，为 W27 版本回放留语义）+ 队列清空
    expect(terminal.current.value.scrollback).toEqual(chunks)
    expect(terminal.current.value.outputQueue).toEqual([])
    expect(terminal.current.value.rafPending).toBe(false)
  })

  it('RQ-2: 同帧 N 条 data 只调度一次 rAF（rafPending 防重入）', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)

    for (let i = 0; i < 8; i++) dispatchSession('s1', makeDataMsg('s1', `chunk-${i};`))
    expect(rafSpy).toHaveBeenCalledTimes(1)
    rafSpy.mockRestore()
  })

  it('RQ-3: E6-a —— rAF 被节流时 outputQueue 超限合并成单块（保序全量，不丢弃）', () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn

    // 不 advance（模拟窗口隐藏 rAF 停摆），喂超上限的 chunk
    const count = 1030
    for (let i = 0; i < count; i++) dispatchSession('s1', makeDataMsg('s1', `c${i};`))

    const q = terminal.current.value.outputQueue
    expect(q.length).toBeLessThan(count)
    // 合并后总内容与逐条等价（保序全量）——flush 前先取内容快照（flush 会清空队列）
    const expected = q.join('')
    expect(expected).toBe(Array.from({ length: count }, (_, i) => `c${i};`).join(''))

    // 恢复帧调度后正常 flush 进 scrollback
    advanceFrame()
    expect(terminal.current.value.scrollback.join('')).toBe(expected)
  })

  it('RQ-4: 跨帧累积语义 —— 各帧 flush 的 chunk 按序追加，总内容一致', () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn

    for (const c of ['a', 'b', 'c']) dispatchSession('s1', makeDataMsg('s1', c))
    advanceFrame()
    for (const c of ['d', 'e']) dispatchSession('s1', makeDataMsg('s1', c))
    advanceFrame()

    expect(terminal.current.value.scrollback).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('RQ-5: scrollback 上限裁剪语义保持（超出 SCROLLBACK_LIMIT 保留最新）', () => {
    const Host = makeHost('s1')
    const wrapper = mount(Host)
    wrappers.push(wrapper)
    const terminal = wrapper.vm.terminal as UseTerminalReturn

    // 分帧喂超上限的 chunk（E6-a 会合并单帧超限的部分，分帧喂保持 chunk 粒度直达上限）
    const total = 5030
    for (let i = 0; i < total; i++) {
      dispatchSession('s1', makeDataMsg('s1', `x${i}`))
      if (i % 100 === 99) advanceFrame()
    }
    advanceFrame()

    const sb = terminal.current.value.scrollback
    expect(sb.length).toBe(5000)
    // 保留最新的 5000 项：5030 - 5000 = 30，x0..x29 被裁掉
    expect(sb[0]).toBe('x30')
    expect(sb[sb.length - 1]).toBe(`x${total - 1}`)
  })
})

// ── Part 2：TerminalView 组件级（data → rAF → watch → xterm.write 端到端）──
describe('D-6.1 rAF 写队列（TerminalView 端到端）', () => {
  it('RQ-6: 同帧 N chunk 只触发一次 xterm.write，内容为合并块', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    for (const c of ['hel', 'lo ', 'raf', ' wor', 'ld\n']) {
      dispatchSession('s1', makeDataMsg('s1', c))
    }
    // flush 前 xterm 不写（等待帧边界）
    expect(xterm.write).not.toHaveBeenCalled()

    advanceFrame()
    await flushPromises() // watch(scrollback.length) 的 microtask 调度

    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('hello raf world\n')
  })

  it('RQ-7: 跨帧各写一次（每帧一次，非每 chunk 一次）', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    const xterm = xtermInstances[xtermInstances.length - 1]!
    xterm.write.mockClear()

    dispatchSession('s1', makeDataMsg('s1', 'f1a'))
    dispatchSession('s1', makeDataMsg('s1', 'f1b'))
    advanceFrame()
    await flushPromises()
    dispatchSession('s1', makeDataMsg('s1', 'f2a'))
    dispatchSession('s1', makeDataMsg('s1', 'f2b'))
    dispatchSession('s1', makeDataMsg('s1', 'f2c'))
    advanceFrame()
    await flushPromises()

    expect(xterm.write).toHaveBeenCalledTimes(2)
    expect(xterm.write).toHaveBeenNthCalledWith(1, 'f1af1b')
    expect(xterm.write).toHaveBeenNthCalledWith(2, 'f2af2bf2c')
  })

  it('RQ-8: 回放语义 —— sessionId 切走再切回，xterm 重挂后全量回放完整', async () => {
    const wrapper = mount(TerminalView, { props: { sessionId: 's1' } })
    wrappers.push(wrapper)
    await flushPromises()

    for (const c of ['out1', 'out2', 'out3']) {
      dispatchSession('s1', makeDataMsg('s1', c))
    }
    advanceFrame()
    await flushPromises()

    // 切到 s2：xterm dispose 重 init（切走 tab/切 session 的回放路径）
    await wrapper.setProps({ sessionId: 's2' })
    await flushPromises()
    // 切回 s1：分区仍在（Map 分区派），新 xterm 实例全量回放
    await wrapper.setProps({ sessionId: 's1' })
    await flushPromises()

    const xterm = xtermInstances[xtermInstances.length - 1]!
    // 回放为单次合并 write，内容 = s1 分区全量（完整无缺漏）
    expect(xterm.write).toHaveBeenCalledTimes(1)
    expect(xterm.write).toHaveBeenCalledWith('out1out2out3')
  })
})
