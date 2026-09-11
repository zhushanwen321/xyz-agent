/**
 * TurnProgressBar 组件行为测试（session-dead-structural-fixes §4 V5① 前端部分 / u4 验收③④）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者白盒：驱动真实 pinia chatStore 事件流（setOccupancy + applyMessageEvent），
 *   断言 core useTurnProgress 派生快照经组件渲染落地
 * - 使用者黑盒：每条用例至少一个用户可见 DOM 断言（testid 文本/存在性）
 * - 观察者形态：v-if 生命周期（turn 结束条消失、无活跃无 DOM）
 *
 * 附 i18n 文案断言（u4 验收③）：zh-CN/en-US sidebar.turnProgress 全部文案无判断词
 * （D7 文案纪律：卡死/无响应/异常/建议中止类禁用）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/turn-progress-bar.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import TurnProgressBar from '@/components/panel/TurnProgressBar.vue'
import { useChatStore } from '@/stores/chat'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { TURN_PROGRESS_WARN_THRESHOLD_MS } from '@xyz-agent/core'
import zhSidebar from '@/i18n/locales/zh-CN/sidebar'
import enSidebar from '@/i18n/locales/en-US/sidebar'

const SID = 's-bar'

/** 真实 store 上构造活跃 turn（occupancy 帧 + message_start 事件，与 runtime 帧序一致）。 */
function startRealTurn(store: ReturnType<typeof useChatStore>, messageId = 'a1'): void {
  store.setOccupancy(SID, { turn: 'generating', compacting: false, bash: false })
  store.applyMessageEvent(SID, { type: 'message.message_start', payload: { sessionId: SID, messageId } })
}

function mountBar() {
  return mount(TurnProgressBar, { props: { sessionId: SID } })
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TurnProgressBar 使用者视角（V5①）', () => {
  it('无活跃 turn：不渲染（常驻条 v-if 生命周期）', () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
  })

  it('活跃 turn：展示本 turn 时长 + 已生成字符（流式 delta 计入）', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    store.applyMessageEvent(SID, { type: 'message.text_delta', payload: { sessionId: SID, delta: 'hello world' } })
    await nextTick()
    const bar = wrapper.find('[data-testid="turn-progress-bar"]')
    expect(bar.exists()).toBe(true)
    // 用户可见事实文案：turn 时长段 + 字符段（delta 已计入）
    expect(bar.find('[data-testid="turn-progress-elapsed"]').text()).toContain('turn')
    expect(bar.find('[data-testid="turn-progress-chars"]').text()).toContain('11')
    expect(bar.find('[data-testid="turn-progress-tool"]').exists()).toBe(false)
  })

  it('当前工具 running：展示工具名与工具时长；工具收口后该段消失', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    store.applyMessageEvent(SID, {
      type: 'message.tool_call_start',
      payload: { sessionId: SID, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'write', arguments: {} } },
    })
    await nextTick()
    vi.advanceTimersByTime(2_000)
    expect(wrapper.find('[data-testid="turn-progress-tool"]').text()).toContain('write')
    store.applyMessageEvent(SID, {
      type: 'message.tool_call_end',
      payload: {
        sessionId: SID,
        entry: {
          type: 'message', id: 'tr1', parentId: 'a1', timestamp: new Date().toISOString(),
          message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'ok' }], timestamp: Date.now() },
        },
      },
    })
    await nextTick()
    expect(wrapper.find('[data-testid="turn-progress-tool"]').exists()).toBe(false)
  })

  it('ask_user pending 豁免态（D6）：只显示「在等待你的输入」分型，不显示计时事实段', async () => {
    const store = useChatStore()
    const extensionUI = useExtensionUIStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    extensionUI.addRequest(SID, {
      sessionId: SID, requestId: 'r1', method: 'select', askUser: true, receivedAt: Date.now(),
    })
    await nextTick()
    vi.advanceTimersByTime(1_000)
    await nextTick()
    expect(wrapper.find('[data-testid="turn-progress-awaiting"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="turn-progress-elapsed"]').exists()).toBe(false)
    // 豁免态不出现操作项（警示不参与）
    expect(wrapper.find('[data-testid="turn-progress-abort"]').exists()).toBe(false)
  })

  it('超阈值：警示色 + 中性操作项出现；「继续等待」抑制警示但事实条保留', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
    await nextTick()
    // 警示态（用户可见：操作项两个中性按钮，不预置推荐）
    expect(wrapper.find('[data-testid="turn-progress-abort"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="turn-progress-keep-waiting"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="turn-progress-abort"]').text()).toContain('turn')
    // 「继续等待」：警示收起，事实条仍在（不是消失）
    await wrapper.find('[data-testid="turn-progress-keep-waiting"]').trigger('click')
    expect(wrapper.find('[data-testid="turn-progress-keep-waiting"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-progress-elapsed"]').exists()).toBe(true)
  })

  it('turn 结束（occupancy idle）：展示自动消失（观察者形态）', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(true)
    store.setOccupancy(SID, { turn: 'idle', compacting: false, bash: false })
    await nextTick()
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
  })

  it('「中止此 turn」：点击 emit abort（由父组件接既有 abort 链路，组件本身不触 RPC）', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
    await nextTick()
    await wrapper.find('[data-testid="turn-progress-abort"]').trigger('click')
    expect(wrapper.emitted('abort')).toHaveLength(1)
  })

  it('≥1h 时长桶：formatDuration 进位到「小时+分」档（durationHourMin，R3 S-3 补测）', async () => {
    const store = useChatStore()
    const wrapper = mountBar()
    startRealTurn(store)
    await nextTick()
    // 65 分钟：跨过 60min 边界 → 小时+分档（不落分钟档）
    vi.advanceTimersByTime(65 * 60 * 1000)
    await nextTick()
    const text = wrapper.find('[data-testid="turn-progress-elapsed"]').text()
    expect(text).toContain('1 小时 5 分')
    expect(text).not.toContain('分钟')
  })
})

describe('i18n 文案纪律断言（u4 验收③，D7）', () => {
  /** D7 禁判断词清单：只陈述事实，禁止「卡死/无响应/异常/建议」类措辞（双语）。 */
  const FORBIDDEN = [
    '卡死', '卡住', '无响应', '没有响应', '异常', '建议', '停滞', '可能失败', '疑似',
    'stuck', 'unresponsive', 'not responding', 'hung', 'freeze', 'error', 'abnormal', 'suggest', 'recommend',
  ]

  function collectLeafTexts(node: unknown, path: string): string[] {
    if (typeof node === 'string') return [`${path} = ${node}`]
    if (node && typeof node === 'object') {
      return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => collectLeafTexts(v, `${path}.${k}`))
    }
    return []
  }

  it.each([
    ['zh-CN', zhSidebar],
    ['en-US', enSidebar],
  ])('%s sidebar.turnProgress 全部文案无判断词', (_locale, sidebar) => {
    const section = (sidebar as { turnProgress: Record<string, unknown> }).turnProgress
    expect(section).toBeDefined()
    const leaves = collectLeafTexts(section, 'turnProgress')
    expect(leaves.length).toBeGreaterThanOrEqual(9)
    for (const leaf of leaves) {
      for (const word of FORBIDDEN) {
        expect(leaf.toLowerCase()).not.toContain(word.toLowerCase())
      }
    }
  })

  it('双语 key 集合一致（对齐检查）', () => {
    const zh = Object.keys((zhSidebar as { turnProgress: Record<string, unknown> }).turnProgress).sort()
    const en = Object.keys((enSidebar as { turnProgress: Record<string, unknown> }).turnProgress).sort()
    expect(en).toEqual(zh)
  })
})
