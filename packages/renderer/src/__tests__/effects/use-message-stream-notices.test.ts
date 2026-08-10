/**
 * useMessageStreamNotices 单测。
 *
 * 验证 fork notice 基线解析（透传给 useNoticeStack）：
 * - vlistBottom=1200 + topOffset=44 → forkNoticeBaseTop=1244
 *
 * [方案 D] dispatching 占位迁入对话流文档流（末尾空 turn 的 TurnMeta），不再是独立 absolute 浮层：
 * - useMessageStreamNotices 不再返回 dispatchingTop（无消费者）
 * - forkNoticeBaseTop 不再叠加 dispatching 占位（dispatching 高度已计入 vlistBottom）
 * - isDispatching/hasWorkingTurn 仍返回（useForkNoticeStream 兜底用）
 *
 * 公式（useNoticeStack.ts，COMPACTING_NOTICE_HEIGHT=46）：
 *   forkNoticeBaseTop = vlistBottom + topOffset + (isCompacting ? 46 : 0)
 *
 * mock 策略：mock useChatStore（控制 isCompacting/isActive/isGenerating 布尔）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-message-stream-notices.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStreamNotices } from '@/composables/panel/useMessageStreamNotices'

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

  it('vlistBottom=1000 + isCompacting=true → forkNoticeBaseTop=1046（叠 compacting 浮层占位）', () => {
    chatState.value.isCompacting = true
    const { ret } = setup({ vlistBottom: 1000 })
    // topOffset 默认 0 → 1000 + 0 + 46(compacting 浮层) = 1046
    expect(ret.forkNoticeBaseTop.value).toBe(1046)
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
