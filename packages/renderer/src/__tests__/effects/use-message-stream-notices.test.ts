/**
 * useMessageStreamNotices 单测（cw wave w4 / W2TC8）。
 *
 * 验证 vlistBottom 基线解析（透传给 useNoticeStack）：
 * - W2TC8 传 vlistBottom=1200 + topOffset=44 → handoffNoticeTop=1244（virtua 路径）
 *
 * [cw wave w4] 删 W2TC7（totalHeight 旧路径）与 W2TC9（vlistBottom/totalHeight 优先级）：
 * totalHeight 字段已删，virtua 是单一滚动 owner，末项底部统一由 vlistBottom 提供。
 *
 * 公式（useNoticeStack.ts，COMPACTING_NOTICE_HEIGHT=HANDOFF_NOTICE_HEIGHT=46）：
 *   handoffNoticeTop = resolveBase() + topOffset + (isCompacting ? 46 : 0)
 *   dispatchingTop   = handoffNoticeTop + (isHandingOff ? 46 : 0)
 *   forkNoticeBaseTop = dispatchingTop + (isDispatching && !hasWorkingTurn ? 46 : 0)
 *
 * mock 策略：mock useChatStore（控制 isCompacting/isHandingOff/isActive/isGenerating 布尔）
 * + mock useSidebar（abortHandoff）。状态全 false 时只验 resolveBase() 分支（基线解析）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-message-stream-notices.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStreamNotices } from '@/composables/panel/useMessageStreamNotices'

// mock useChatStore：返回可配置的布尔状态（isCompacting/isHandingOff/isActive/isGenerating）
// 默认全 false（验基线公式时不叠加占位）。每个测试可覆盖。
const chatState = ref({
  isCompacting: false,
  isHandingOff: false,
  isActive: false,
  isGenerating: false,
})
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    isCompacting: () => chatState.value.isCompacting,
    isHandingOff: () => chatState.value.isHandingOff,
    isActive: () => chatState.value.isActive,
    isGenerating: () => chatState.value.isGenerating,
  }),
}))

// mock useSidebar：abortHandoff 不做真实 RPC
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ abortHandoff: vi.fn() }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  chatState.value = { isCompacting: false, isHandingOff: false, isActive: false, isGenerating: false }
})

/**
 * mount useMessageStreamNotices（effectScope 包裹，返回 computed 供断言）。
 * hasWorkingTurn 默认 false（验基线公式时不叠 dispatching 占位）。
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

// ── W2TC8: 传 vlistBottom（virtua 路径） ────────────────────────────

describe('useMessageStreamNotices · W2TC8: vlistBottom 基线', () => {
  it('vlistBottom=1200 + topOffset=44 → handoffNoticeTop=1244', () => {
    const { ret } = setup({ vlistBottom: 1200, topOffset: 44 })
    expect(ret.handoffNoticeTop.value).toBe(1244)
    // dispatching/fork 同基线（无 handoff/dispatching 占位）
    expect(ret.dispatchingTop.value).toBe(1244)
    expect(ret.forkNoticeBaseTop.value).toBe(1244)
  })

  it('vlistBottom=1000 + isCompacting=true → handoffNoticeTop=1000+46=1046（叠 compacting 占位）', () => {
    chatState.value.isCompacting = true
    const { ret } = setup({ vlistBottom: 1000 })
    // topOffset 默认 0 → 1000 + 0 + 46(compacting) = 1046
    expect(ret.handoffNoticeTop.value).toBe(1046)
  })

  it('vlistBottom=1200 + isHandingOff=true → dispatchingTop=handoff+46', () => {
    chatState.value.isHandingOff = true
    const { ret } = setup({ vlistBottom: 1200 })
    // handoffNoticeTop = 1200 + 0 + 0 = 1200；dispatchingTop = 1200 + 46 = 1246
    expect(ret.handoffNoticeTop.value).toBe(1200)
    expect(ret.dispatchingTop.value).toBe(1246)
  })

  it('vlistBottom=1200 + isDispatching(!hasWorkingTurn) → forkNoticeBaseTop=dispatching+46', () => {
    // isDispatching = isActive && !isGenerating；hasWorkingTurn=false
    chatState.value.isActive = true
    chatState.value.isGenerating = false
    const { ret } = setup({ vlistBottom: 1200 })
    // handoff=1200; dispatching=1200（无 handoff 占位）; fork=1200+46=1246
    expect(ret.forkNoticeBaseTop.value).toBe(1246)
  })
})

