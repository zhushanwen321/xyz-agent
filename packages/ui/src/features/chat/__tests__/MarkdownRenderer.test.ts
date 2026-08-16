/**
 * MarkdownRenderer D-5 增量消费测试（W23，mock deps 组件行为层）。
 *
 * 覆盖（plan.md W23 验收 ①②③ 的组件逻辑面；真实 renderIncremental 集成在 renderer 侧
 * markdown-renderer-incremental.test.ts）：
 * - 壳未提供增量能力 → 回退 renderMarkdown 全量渲染（mock 壳兼容，等价旧版）
 * - 增量渲染树 = 前缀段 + 尾段；前缀段 DOM 引用跨帧稳定（v-for :key=segId 复用）
 * - streaming-fence 占位：语言名可见 + 不加载 mermaid（R-20 占位形态）
 * - 静默 ≥阈值 / streaming 翻 false → finalizeOpenFence:true 转完整渲染
 * - 增量渲染抛错 → 降级转义纯文本可见 + 缓存句柄作废
 *
 * rAF 处理：手动队列模拟真实异步 rAF（mount 后 flushRaf() 触发帧回调）。不用同步 rAF 覆盖
 * ——scheduleRender 的 rafId 赋值时序在同步回调下会残留 stale id，丢后续渲染（仅单帧渲染的
 * 旧 fallback 测试不受影响，多帧更新测试必须异步语义）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/MarkdownRenderer.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { MarkdownRenderer } from '@xyz-agent/ui'
import type { ChatViewDeps, IncrementalMarkdownCache, IncrementalMarkdownResult, MarkdownSegment } from '@xyz-agent/ui'
import { createMockDeps, mockChatProvide } from './helpers'

// ── rAF 手动队列（异步语义，见文件头注释）──
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 触发一帧：执行已排队的 rAF 回调 + 等 doRender 异步链落定 */
async function flushRaf(): Promise<void> {
  const cbs = [...rafQueue]
  rafQueue.length = 0
  for (const cb of cbs) cb(0)
  await nextTick()
  await nextTick()
  await nextTick()
}

/** 构造增量 mock 的段/缓存工厂（协议形状对齐 renderer renderIncremental 输出） */
function seg(type: MarkdownSegment['type'], content: string, segId: number, extra: Partial<MarkdownSegment> = {}): MarkdownSegment {
  return { type, content, segId, ...extra }
}
function emptyCache(nextSegId: number): IncrementalMarkdownCache {
  return { boundary: 0, prefixText: '', prefixSegments: [], nextSegId }
}
function incResult(prefix: MarkdownSegment[], tail: MarkdownSegment[], cache: IncrementalMarkdownCache): IncrementalMarkdownResult & { cache: IncrementalMarkdownCache } {
  return { prefixSegments: prefix, tailSegments: tail, stableBoundary: 0, mode: 'incremental', cache }
}

function mountMd(props: Record<string, unknown>, depsOverrides: Partial<ChatViewDeps> = {}) {
  return mount(MarkdownRenderer, {
    props: props as never,
    global: {
      provide: mockChatProvide(depsOverrides),
      stubs: {
        MermaidRenderer: true,
        AmbiguousFilePopover: { name: 'AmbiguousFilePopover', render: () => null },
      },
    },
  })
}

describe('W23: 壳未提供增量能力 → 回退全量渲染（mock 壳兼容）', () => {
  it('无 renderMarkdownIncremental 时走 deps.renderMarkdown，段正常渲染', async () => {
    const renderMarkdown = vi.fn().mockResolvedValue([{ type: 'text', content: '<p>hello</p>' }])
    const wrapper = mountMd({ content: 'hello' }, { renderMarkdown })
    await flushRaf()
    expect(renderMarkdown).toHaveBeenCalledWith('hello', undefined)
    expect(wrapper.find('.md-render > div').html()).toContain('<p>hello</p>')
  })
})

describe('W23 ①: 增量更新只重渲染尾段（前缀段 DOM 引用跨帧稳定）', () => {
  it('前缀段 DOM 节点引用恒等，尾段节点重建', async () => {
    const segA = seg('text', '<p>para one</p>', 0)
    let call = 0
    const renderMarkdownIncremental = vi.fn(async (): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
      call += 1
      if (call === 1) return incResult([], [segA, seg('text', '<p>tail v1</p>', 1)], emptyCache(2))
      // 第二帧：segA 晋升为前缀（引用恒等），尾段重建
      return incResult([segA], [seg('text', '<p>tail v2</p>', 2)], emptyCache(3))
    })
    const wrapper = mountMd(
      { content: 'para one\n\ntail v1', streaming: true },
      { renderMarkdownIncremental },
    )
    await flushRaf()
    const divsBefore = wrapper.findAll('.md-render > div')
    expect(divsBefore).toHaveLength(2)
    const prefixEl = divsBefore[0].element

    await wrapper.setProps({ content: 'para one\n\ntail v2' } as never)
    await flushRaf()
    const divsAfter = wrapper.findAll('.md-render > div')
    expect(divsAfter).toHaveLength(2)
    // 前缀段 DOM 引用恒等（v-for :key=segId 命中，子树不触碰）
    expect(divsAfter[0].element).toBe(prefixEl)
    expect(divsAfter[0].html()).toContain('para one')
    // 尾段内容更新
    expect(divsAfter[1].html()).toContain('tail v2')
    expect(renderMarkdownIncremental).toHaveBeenCalledTimes(2)
  })
})

describe('W23 ②: streaming-fence 占位渲染（R-20：语言名 + loader 行，不加载重库）', () => {
  it('代码 fence 占位：语言名可见，无 shiki 产物（占位段不渲染代码块）', async () => {
    const renderMarkdownIncremental = vi.fn(async () =>
      incResult(
        [seg('text', '<p>intro</p>', 0)],
        [seg('streaming-fence', 'const a = 1', 1, { lang: 'ts', mermaid: false })],
        emptyCache(2),
      ),
    )
    const wrapper = mountMd(
      { content: 'intro\n\n```ts\nconst a = 1', streaming: true },
      { renderMarkdownIncremental },
    )
    await flushRaf()

    const placeholder = wrapper.find('[data-testid="md-streaming-fence"]')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.find('[data-testid="md-streaming-fence-lang"]').text()).toBe('ts')
    // 占位期无代码块产物（shiki/mermaid 都不跑）
    expect(wrapper.find('.md-codeblock').exists()).toBe(false)
    expect(wrapper.find('pre.shiki').exists()).toBe(false)
  })

  it('mermaid fence 占位：语言名可见，不加载 mermaid（无 MermaidRenderer 挂载）', async () => {
    const renderMermaid = vi.fn().mockResolvedValue({ svg: '<svg/>' })
    const renderMarkdownIncremental = vi.fn(async () =>
      incResult(
        [],
        [seg('streaming-fence', 'graph LR\nA-->B', 0, { lang: 'mermaid', mermaid: true })],
        emptyCache(1),
      ),
    )
    const wrapper = mountMd(
      { content: '```mermaid\ngraph LR\nA-->B', streaming: true },
      { renderMarkdownIncremental, renderMermaid },
    )
    await flushRaf()

    const placeholder = wrapper.find('[data-testid="md-streaming-fence"]')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.find('[data-testid="md-streaming-fence-lang"]').text()).toBe('mermaid')
    // finalize 前不加载 mermaid（无组件挂载、无渲染调用）
    expect(wrapper.findComponent({ name: 'MermaidRenderer' }).exists()).toBe(false)
    expect(renderMermaid).not.toHaveBeenCalled()
  })
})

describe('W23 ③: 静默/complete 转完整渲染（finalizeOpenFence:true）', () => {
  function finalizeAwareMock() {
    const calls: { source: string; finalize: boolean }[] = []
    const renderMarkdownIncremental = vi.fn(
      async (source: string, _cache: IncrementalMarkdownCache | null, _sid?: string, opts?: { finalizeOpenFence?: boolean }): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
        const finalize = opts?.finalizeOpenFence === true
        calls.push({ source, finalize })
        if (finalize) return incResult([], [seg('text', '<div class="md-codeblock">code</div>', 0)], emptyCache(1))
        return incResult([], [seg('streaming-fence', 'code', 0, { lang: 'ts' })], emptyCache(1))
      },
    )
    return { calls, renderMarkdownIncremental }
  }

  it('token 静默 ≥ 阈值 → 定时器触发 finalize 完整渲染', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { calls, renderMarkdownIncremental } = finalizeAwareMock()
    const shouldFinalizeStreamingFence = vi.fn(({ complete, silenceMs }: { complete: boolean; silenceMs: number }) =>
      complete || silenceMs >= 200,
    )
    const wrapper = mountMd(
      { content: '```ts\ncode', streaming: true },
      { renderMarkdownIncremental, shouldFinalizeStreamingFence, streamingFenceSilenceMs: 200 },
    )
    await flushRaf()
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].finalize).toBe(false)

    // 静默 250ms ≥ 阈值 200ms → finalize 定时器触发
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    await nextTick()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[calls.length - 1].finalize).toBe(true)
    // 占位被完整代码块替换
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
    expect(wrapper.find('.md-codeblock').exists()).toBe(true)
  })

  it('streaming true→false（消息 complete）→ 立即 finalize，不等静默', async () => {
    const { calls, renderMarkdownIncremental } = finalizeAwareMock()
    const shouldFinalizeStreamingFence = vi.fn(({ complete }: { complete: boolean; silenceMs: number }) => complete)
    const wrapper = mountMd(
      { content: '```ts\ncode', streaming: true },
      { renderMarkdownIncremental, shouldFinalizeStreamingFence, streamingFenceSilenceMs: 200 },
    )
    await flushRaf()
    expect(calls[0].finalize).toBe(false)

    await wrapper.setProps({ streaming: false } as never)
    await flushRaf()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[calls.length - 1].finalize).toBe(true)
    expect(wrapper.find('.md-codeblock').exists()).toBe(true)
  })

  it('壳未提供静默阈值 → 仅 complete 触发 finalize（不安排静默定时器）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { calls, renderMarkdownIncremental } = finalizeAwareMock()
    const shouldFinalizeStreamingFence = vi.fn(({ complete }: { complete: boolean; silenceMs: number }) => complete)
    mountMd(
      { content: '```ts\ncode', streaming: true },
      { renderMarkdownIncremental, shouldFinalizeStreamingFence },
    )
    await flushRaf()
    await vi.advanceTimersByTimeAsync(500)
    // 静默路径未激活：仍只有首帧渲染，无 finalize
    expect(calls).toHaveLength(1)
    expect(calls[0].finalize).toBe(false)
  })
})

describe('W23: 增量渲染失败降级（等价旧版兜底 + 缓存作废）', () => {
  it('renderMarkdownIncremental reject → 转义纯文本可见，缓存句柄作废后下次重建', async () => {
    let call = 0
    const renderMarkdownIncremental = vi.fn(
      async (_source: string, cache: IncrementalMarkdownCache | null): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
        call += 1
        if (call === 1) throw new Error('shiki load failed')
        // 第二次调用断言收到 null 缓存（第一次失败后作废）
        expect(cache).toBeNull()
        return incResult([], [seg('text', '<p>recovered</p>', 0)], emptyCache(1))
      },
    )
    const wrapper = mountMd(
      { content: '<script>alert(1)</script>', streaming: true },
      { renderMarkdownIncremental },
    )
    await flushRaf()
    // 降级：原文可见且转义（无真 <script> 节点）
    expect(wrapper.text()).toContain('<script>alert(1)</script>')
    expect(wrapper.find('script').exists()).toBe(false)

    await wrapper.setProps({ content: 'second message' } as never)
    await flushRaf()
    expect(renderMarkdownIncremental).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('recovered')
  })

  it('空内容：segments 清空且缓存作废（新消息从头渲染）', async () => {
    const renderMarkdownIncremental = vi.fn(
      async (source: string, cache: IncrementalMarkdownCache | null): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => {
        if (!source.trim()) return { prefixSegments: [], tailSegments: [], stableBoundary: 0, mode: 'incremental', cache: cache ?? emptyCache(0) }
        return incResult([], [seg('text', `<p>${source}</p>`, 0)], emptyCache(1))
      },
    )
    const wrapper = mountMd({ content: 'hello', streaming: true }, { renderMarkdownIncremental })
    await flushRaf()
    expect(wrapper.findAll('.md-render > div')).toHaveLength(1)

    await wrapper.setProps({ content: '' } as never)
    await flushRaf()
    expect(wrapper.findAll('.md-render > *')).toHaveLength(0)
    // 空内容路径作废缓存：下次渲染收到 null
    await wrapper.setProps({ content: 'next' } as never)
    await flushRaf()
    const lastCall = renderMarkdownIncremental.mock.calls[renderMarkdownIncremental.mock.calls.length - 1]
    expect(lastCall?.[1]).toBeNull()
  })
})
