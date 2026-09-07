/**
 * useMessageStreamNotices 单测。
 *
 * 验证 fork notice 基线解析（透传给 useNoticeStack）：
 * - vlistBottom=1200 + topOffset=44 → forkNoticeBaseTop=1244
 *
 * [u6a / D7 展示统一] compacting/bash/dispatching 三处指示行已收编 ActivityStrip 组件
 * （文档流 block，Virtualizer 之后），fork notice 生产定位 = 文档序自然堆叠（不消费本基线）：
 * - compactingText 已退役（文案逻辑迁 ActivityStrip，按 reason 区分手动/自动）
 * - 本基线（forkNoticeBaseTop）仅供 useForkNoticeStream 兜底通路（生产 injectedBaseTop 短路
 *   且 forkNoticeTop 不被模板消费，双重不触发）；公式锚点测试保留防漂移
 * - isDispatching/hasWorkingTurn 仍返回（useForkNoticeStream 兜底 deps，签名不变）
 *
 * 公式（useNoticeStack.ts，COMPACTING_NOTICE_HEIGHT=24）：
 *   forkNoticeBaseTop = vlistBottom + topOffset + (isCompacting ? 24 : 0)
 *
 * 注：断言用 import 的 COMPACTING_NOTICE_HEIGHT 常量计算，避免常量变更再次漂移。
 *
 * mock 策略：mock useChatStore（控制 isCompacting/isActive/isGenerating 布尔）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-message-stream-notices.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStreamNotices, COMPACTING_NOTICE_HEIGHT } from '@/composables/panel/useMessageStreamNotices'

// mock useChatStore：返回可配置的布尔状态（isCompacting/isActive/isGenerating）
const chatState = ref({
  isCompacting: false,
  isActive: false,
  isGenerating: false,
})
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    isCompacting: () => chatState.value.isCompacting,
    isActive: () => chatState.value.isActive,
    isGenerating: () => chatState.value.isGenerating,
  }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  chatState.value = { isCompacting: false, isActive: false, isGenerating: false }
})

/**
 * mount useMessageStreamNotices（effectScope 包裹，返回 computed 供断言）。
 */
function setup(opts: {
  vlistBottom?: number
  topOffset?: number
  hasWorkingTurn?: () => boolean
}) {
  const sessionId = computed(() => 's-notices-test')
  const vlistBottom = computed(() => opts.vlistBottom ?? 0)
  const topOffset = computed(() => opts.topOffset ?? 0)
  const hasWorkingTurn = opts.hasWorkingTurn ?? (() => false)

  const scope = effectScope()
  let ret: ReturnType<typeof useMessageStreamNotices> | undefined
  scope.run(() => {
    ret = useMessageStreamNotices({
      sessionId,
      vlistBottom,
      topOffset,
      hasWorkingTurn,
    })
  })
  return { scope, ret: ret! }
}

describe('useMessageStreamNotices · forkNoticeBaseTop 基线', () => {
  it('vlistBottom=1200 + topOffset=44 → forkNoticeBaseTop=1244', () => {
    const { ret } = setup({ vlistBottom: 1200, topOffset: 44 })
    expect(ret.forkNoticeBaseTop.value).toBe(1244)
  })

  it('vlistBottom=1000 + isCompacting=true → forkNoticeBaseTop=1024（叠 compacting 浮层占位）', () => {
    chatState.value.isCompacting = true
    const { ret } = setup({ vlistBottom: 1000 })
    // topOffset 默认 0 → 1000 + 0 + 24(compacting 浮层) = 1024
    expect(ret.forkNoticeBaseTop.value).toBe(1000 + COMPACTING_NOTICE_HEIGHT)
  })

  it('[方案 D] isDispatching 不再叠加 fork 基线占位（dispatching 已迁入文档流，计入 vlistBottom）', () => {
    // isDispatching = isActive && !isGenerating
    chatState.value.isActive = true
    chatState.value.isGenerating = false
    const { ret } = setup({ vlistBottom: 1200 })
    // forkNoticeBaseTop = 1200（不加 dispatching 占位，dispatching 高度已在 vlistBottom 内）
    expect(ret.forkNoticeBaseTop.value).toBe(1200)
    // isDispatching 仍正确计算（供 useForkNoticeStream 兜底）
    expect(ret.isDispatching.value).toBe(true)
  })
})
