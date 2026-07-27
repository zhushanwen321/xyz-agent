/**
 * BashOutputBlock 组件测试（composer-bash-execute W3 TK8 + W4 RO 上报 + 视觉降级）。
 *
 * 验证：
 * - complete 态 exit 0 → command + output + 「exit 0」success 标签
 * - streaming 态 → spinner + 取消按钮；点击取消触发 abortBash
 * - exit N(>0) → 「exit N」danger 标签
 * - excludeFromContext=true → no context 标记
 * - cancelled=true → 「cancelled」标签
 * - output='' → 「(no output)」
 * - W4T1：注册 useResizeReport 且 RO 回调上报的 key 是 `s-${message.id}`（带 s- 前缀，
 *   与 useVirtualTurnList itemKey 的 system 项格式一致）
 * - W4T2：视觉对齐 trace block 极简风（根 div 无 border/rounded-md/bg-surface-hover，有 py-2）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/BashOutputBlock.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@xyz-agent/shared'
import { TURN_RESIZE_REGISTRY_KEY } from '@/composables/effects/useResizeReport'

// Mock useChat.abortBash（BashOutputBlock 取消按钮的唯一外部依赖）
const mockAbortBash = vi.fn()
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ abortBash: mockAbortBash }),
}))

import BashOutputBlock from '@/components/panel/message-stream/BashOutputBlock.vue'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'bash-1',
    role: 'system',
    content: '',
    status: 'complete',
    bashExecution: {
      command: 'ls -la',
      output: 'total 0',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      timestamp: 1000,
    },
    timestamp: 1000,
    ...overrides,
  } as Message
}

function mountBlock(message: Message) {
  return mount(BashOutputBlock, {
    props: { message, sessionId: 'sess-1' },
    global: { plugins: [] },
  })
}

describe('BashOutputBlock', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockAbortBash.mockReset()
  })

  it('complete 态 exit 0 → 显示 command + output + 「exit 0」标签（success 类）', () => {
    const wrapper = mountBlock(makeMessage())
    expect(wrapper.find('[data-testid="bash-output-block"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('ls -la')
    expect(wrapper.text()).toContain('total 0')
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toBe('exit 0')
    expect(tag.classes()).toContain('text-success')
  })

  it('streaming 态 → spinner + 取消按钮存在；点击取消触发 abortBash', async () => {
    const msg = makeMessage({
      status: 'streaming',
      bashExecution: {
        command: 'sleep 10',
        output: '',
        exitCode: null,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    // streaming 不渲染 status-tag（spinner 无 testid），取消按钮存在
    expect(wrapper.find('[data-testid="bash-status-tag"]').exists()).toBe(false)
    const cancelBtn = wrapper.find('[data-testid="bash-cancel-btn"]')
    expect(cancelBtn.exists()).toBe(true)
    await cancelBtn.trigger('click')
    expect(mockAbortBash).toHaveBeenCalledWith('sess-1')
  })

  it('exitCode=2 → 「exit 2」标签（danger 类）', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'false',
        output: '',
        exitCode: 2,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.text()).toBe('exit 2')
    expect(tag.classes()).toContain('text-danger')
  })

  it('excludeFromContext=true → 显示 no context 标记', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'echo hi',
        output: 'hi',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    expect(wrapper.find('[data-testid="bash-no-context-tag"]').exists()).toBe(true)
  })

  it('cancelled=true → 「cancelled」标签', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'sleep 5',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.exists()).toBe(true)
    // i18n 文案随 locale（zh-CN 「已取消」/en-US 「cancelled」），断言非空即可
    expect(tag.text().length).toBeGreaterThan(0)
    expect(tag.classes()).toContain('text-muted')
  })

  it('output 为空且非 streaming → 显示 (no output)', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'true',
        output: '',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    // 输出区不渲染（无 output），空输出提示渲染
    expect(wrapper.find('[data-testid="bash-output"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bash-output-empty"]').exists()).toBe(true)
  })

  // ── W4：消费 truncated 字段显示截断标记（pi 对超长输出截断时返回 truncated:true）──

  it('W4: truncated=true → 输出区底部显示截断标记', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'cat huge.log',
        output: '...部分输出...',
        exitCode: 0,
        cancelled: false,
        truncated: true,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    const truncatedTag = wrapper.find('[data-testid="bash-output-truncated"]')
    expect(truncatedTag.exists()).toBe(true)
    expect(truncatedTag.text().length).toBeGreaterThan(0)
  })

  it('W4: truncated=false → 不渲染截断标记', () => {
    const wrapper = mountBlock(makeMessage()) // 默认 truncated:false
    expect(wrapper.find('[data-testid="bash-output-truncated"]').exists()).toBe(false)
  })

  // ── W5：超时态（error:'timeout'）与 cancelled 视觉区分 ──

  it('W5: error=timeout + cancelled=true → 显示超时文案（非已取消），优先级 timeout > cancelled', () => {
    // finalizeBashOnly 超时收口：status:error + cancelled:true + error:'timeout'
    const msg = makeMessage({
      status: 'error',
      error: 'timeout',
      bashExecution: {
        command: 'sleep 999',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    } as Partial<Message>)
    const wrapper = mountBlock(msg)
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.exists()).toBe(true)
    // 超时态走 bashTimeout（zh-CN「已超时」），不应是已取消（zh-CN「已取消」）
    expect(tag.text().length).toBeGreaterThan(0)
    expect(tag.classes()).toContain('text-muted')
    // 验证走的是 timeout 分支而非 cancelled 分支：两个文案 key 不同 → 文案不同
    expect(tag.text()).not.toBe('已取消')
  })

  it('W5: cancelled=true 但无 error → 仍显示已取消（非超时）', () => {
    const msg = makeMessage({
      bashExecution: {
        command: 'sleep 5',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(msg)
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.exists()).toBe(true)
    // 无 error → 走 cancelled 分支（已取消），不是超时
    expect(tag.text()).not.toBe('已超时')
  })
})

// ── gap2：streaming → complete 态切换的用户可见过渡（reactive props 更新）──
//
// PR#116 review gap2：现有 streaming 态（cancel-btn 存在）与 complete 态（output 显示）分两个
// 独立 it 用静态 props 快照测试，未驱动同一条 message 从 streaming 切到 complete 验证过渡
//（spinner 消失 + output 出现 + exit 标签显示）。本组补这条：mount 后 setProps 更新 message，
// 断言过渡前后 DOM 变化（reactive props 响应式更新路径）。
describe('BashOutputBlock streaming → complete 过渡（PR#116 review gap2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockAbortBash.mockReset()
  })

  it('gap2: streaming（spinner + cancel-btn + 无 output）→ 更新 props 到 complete → spinner/cancel 消失 + output 出现 + exit 标签显示', async () => {
    // 初始：streaming 态（bashStart 创建的 loading 消息）
    const streamingMsg = makeMessage({
      status: 'streaming',
      bashExecution: {
        command: 'npm test',
        output: '',
        exitCode: null,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(streamingMsg)

    // ── 过渡前：loading 态 ──
    // cancel-btn 存在（streaming 态可取消）
    expect(wrapper.find('[data-testid="bash-cancel-btn"]').exists()).toBe(true)
    // status-tag 不渲染（streaming 走 spinner 分支，无 status-tag testid）
    expect(wrapper.find('[data-testid="bash-status-tag"]').exists()).toBe(false)
    // output 区不渲染（streaming 态 v-if="!isStreaming && hasOutput"）
    expect(wrapper.find('[data-testid="bash-output"]').exists()).toBe(false)
    // command 文本始终渲染（header 不分态）
    expect(wrapper.text()).toContain('npm test')

    // ── 触发过渡：bashResult 锢定消息更新为 complete 态（reactive props 更新）──
    const completeMsg = makeMessage({
      status: 'complete',
      bashExecution: {
        command: 'npm test',
        output: 'PASS  src/foo.test.ts\n✓ 1 test',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    await wrapper.setProps({ message: completeMsg })

    // ── 过渡后：complete 态 ──
    // spinner/cancel-btn 消失（streaming=false）
    expect(wrapper.find('[data-testid="bash-cancel-btn"]').exists()).toBe(false)
    // status-tag 出现，显示 exit 0（success 类）
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toBe('exit 0')
    expect(tag.classes()).toContain('text-success')
    // output 区出现，含完整输出
    const output = wrapper.find('[data-testid="bash-output"]')
    expect(output.exists()).toBe(true)
    expect(output.text()).toContain('PASS  src/foo.test.ts')
  })

  it('gap2: streaming → 更新到 complete 但 exit N(>0) → exit 标签显示 danger 类', async () => {
    const streamingMsg = makeMessage({
      status: 'streaming',
      bashExecution: {
        command: 'npm test',
        output: '',
        exitCode: null,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    const wrapper = mountBlock(streamingMsg)
    // 过渡前：cancel-btn 存在
    expect(wrapper.find('[data-testid="bash-cancel-btn"]').exists()).toBe(true)

    // 过渡：exit 2（失败）
    const failedMsg = makeMessage({
      status: 'complete',
      bashExecution: {
        command: 'npm test',
        output: 'FAIL  src/bar.test.ts',
        exitCode: 2,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
    })
    await wrapper.setProps({ message: failedMsg })

    // 过渡后：cancel 消失 + exit 2 danger 标签 + output
    expect(wrapper.find('[data-testid="bash-cancel-btn"]').exists()).toBe(false)
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toBe('exit 2')
    expect(tag.classes()).toContain('text-danger')
    expect(wrapper.find('[data-testid="bash-output"]').exists()).toBe(true)
  })
})

// ── W4：RO 上报 + 视觉降级 ──────────────────────────────────────────
//
// useResizeReport 通过 provide(TURN_RESIZE_REGISTRY_KEY) inject 拿 registry；
// 测试需 provide 一个 mock registry（含 reportHeight spy）。
// happy-dom 不提供 ResizeObserver，需 stub 一个能记录 observe 的最小实现，
// 测试可拿到实例后手动触发回调以验证 key。

describe('BashOutputBlock W4 — RO 上报 + 视觉降级', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockAbortBash.mockReset()
  })

  function mountWithRegistry(message: Message, reportHeight: (key: string, h: number) => void) {
    return mount(BashOutputBlock, {
      props: { message, sessionId: 'sess-1' },
      global: {
        plugins: [],
        provide: {
          [TURN_RESIZE_REGISTRY_KEY as symbol]: { reportHeight },
        },
      },
    })
  }

  it('W4T1: RO 回调触发后 reportHeight 被调用且第一参数 = `s-${message.id}`（带 s- 前缀，匹配 itemKey system 格式）', async () => {
    // 用构造器 spy：拦截 new ResizeObserver，记录回调与元素，手动 trigger 高度
    const captured: Array<{ cb: (entries: ResizeObserverEntry[]) => void; el: HTMLElement | null }> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (entries: ResizeObserverEntry[]) => void) {
        captured.push({ cb, el: null })
      }
      observe(el: HTMLElement): void {
        captured[captured.length - 1]!.el = el
      }
      unobserve(): void { /* noop */ }
      disconnect(): void { /* noop */ }
    })

    const reportHeight = vi.fn()
    const msg = makeMessage({ id: 'bash-789' })
    const wrapper = mountWithRegistry(msg, reportHeight)

    // 等待 watch immediate 触发 observe
    await wrapper.vm.$nextTick()

    expect(captured.length).toBeGreaterThanOrEqual(1)
    const ro = captured[0]!
    expect(ro.el).not.toBeNull()
    const el = ro.el as HTMLElement
    // 模拟浏览器 RO 高度回调（borderBoxSize[0].blockSize 路径，280px 模拟长输出真实高度）
    ro.cb([{
      target: el,
      borderBoxSize: [{ blockSize: 280 } as ResizeObserverSize],
      contentRect: {} as DOMRectReadOnly,
    }] as unknown as ResizeObserverEntry[])

    expect(reportHeight).toHaveBeenCalledTimes(1)
    // ⚠️ key 必须带 s- 前缀：与 useVirtualTurnList itemKey 的 system 项格式 `s-${id}` 一致，
    // 否则高度写不进 heights Map → 仍走 200px 估算 → 长输出 item offset 算错 → 视觉重叠
    expect(reportHeight).toHaveBeenCalledWith('s-bash-789', 280)
    wrapper.unmount()
  })

  it('W4T1b: 未 provide registry（非虚拟列表环境）→ useResizeReport 优雅降级，不抛错', () => {
    // 不 provide registry（如纯展示场景）→ useResizeReport inject 拿到 null → no-op
    expect(() => mountBlock(makeMessage())).not.toThrow()
  })

  it('W4T2: 根 div 无 border / rounded-md / bg-surface-hover class（对齐 trace block 极简风）', () => {
    const wrapper = mountBlock(makeMessage())
    const root = wrapper.find('[data-testid="bash-output-block"]')
    expect(root.exists()).toBe(true)
    const classes = root.classes()
    // FR-5：去卡片样式（无边框、无圆角、无浅底）
    expect(classes).not.toContain('border')
    expect(classes).not.toContain('border-border')
    expect(classes).not.toContain('rounded-md')
    expect(classes.some((c) => c.startsWith('bg-surface-hover'))).toBe(false)
    // 极简风保留 py-2（与 Block.vue trace-blk py-2 一致）
    expect(classes).toContain('py-2')
  })
})
