/**
 * useForkNoticeStream 双轨单测（cw wave w2 / W2TC10-W2TC11）。
 *
 * 验证 forkNoticeBaseTop 优先级链（injectedBaseTop > vlistBottom > totalHeight > 0）：
 * - W2TC10 传 injectedBaseTop=500 → forkNoticeBaseTop=500（短路）；forkNoticeTop(1)=500+FORK_NOTICE_HEIGHT
 * - W2TC11 不传 injectedBaseTop，传 vlistBottom=1200 + topOffset=44 → baseTop=1244
 * - W2TC11b 传 totalHeight=1000（无 vlistBottom/injected）→ baseTop=1000+topOffset（旧路径）
 * - W2TC11c 传 vlistBottom + totalHeight（无 injected）→ vlistBottom 优先
 *
 * FORK_NOTICE_HEIGHT=40（useForkNoticeStream.ts:22 私有常量，未导出）。通过 forkNoticeTop(idx)
 * 的垂直堆叠步进断言：forkNoticeTop(idx) = forkNoticeBaseTop + idx * 40。
 *
 * mock 策略：mock useForkNoticeFeed（notices 返回 []，dismissNotice vi.fn）+ useSidebar。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-fork-notice-stream.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useForkNoticeStream } from '@/composables/panel/useForkNoticeStream'

// mock useForkNoticeFeed：notices 返回空（本测只验定位，不验 feed 消费），dismissNotice vi.fn
vi.mock('@/composables/effects/useForkNoticeEffect', () => ({
  useForkNoticeFeed: () => ({
    notices: () => [],
    dismissNotice: vi.fn(),
  }),
}))

// mock useSidebar：selectSession 不做真实跳转
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ selectSession: vi.fn() }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
})

/** mount useForkNoticeStream（effectScope 包裹）。sessionId getter 返回固定字符串。 */
function setup(opts: {
  injectedBaseTop?: number
  vlistBottom?: number
  totalHeight?: number
  topOffset?: number
  isCompacting?: boolean
  isHandingOff?: boolean
  isDispatching?: boolean
  hasWorkingTurn?: boolean
}) {
  const sessionId = () => 's-fork-test'
  const injectedBaseTop =
    opts.injectedBaseTop != null ? computed(() => opts.injectedBaseTop!) : undefined
  const vlistBottom = opts.vlistBottom != null ? computed(() => opts.vlistBottom!) : undefined
  const totalHeight = opts.totalHeight != null ? computed(() => opts.totalHeight!) : undefined
  const topOffset = computed(() => opts.topOffset ?? 0)
  const isCompacting = computed(() => opts.isCompacting ?? false)
  const isDispatching = computed(() => opts.isDispatching ?? false)
  const hasWorkingTurn = computed(() => opts.hasWorkingTurn ?? false)
  const isHandingOff = computed(() => opts.isHandingOff ?? false)

  const scope = effectScope()
  let ret: ReturnType<typeof useForkNoticeStream> | undefined
  scope.run(() => {
    ret = useForkNoticeStream(sessionId, {
      totalHeight,
      vlistBottom,
      topOffset,
      isCompacting,
      isDispatching,
      hasWorkingTurn,
      compactNoticeHeight: 46,
      isHandingOff,
      handoffNoticeHeight: 46,
      injectedBaseTop,
    })
  })
  return { scope, ret: ret! }
}

// ── W2TC10: injectedBaseTop 短路 ───────────────────────────────────

describe('useForkNoticeStream · W2TC10: injectedBaseTop 短路', () => {
  it('injectedBaseTop=500 → forkNoticeTop(0)=500, forkNoticeTop(1)=540（堆叠 FORK_NOTICE_HEIGHT=40）', () => {
    const { ret } = setup({ injectedBaseTop: 500 })

    expect(ret.forkNoticeTop(0)).toBe(500)
    expect(ret.forkNoticeTop(1)).toBe(540)
    expect(ret.forkNoticeTop(2)).toBe(580)
  })

  it('injectedBaseTop=500 短路：忽略 totalHeight/vlistBottom/占位状态', () => {
    // 即使传 totalHeight=9999 + isCompacting=true，injectedBaseTop 仍优先
    const { ret } = setup({
      injectedBaseTop: 500,
      totalHeight: 9999,
      vlistBottom: 8888,
      isCompacting: true,
      isHandingOff: true,
    })

    expect(ret.forkNoticeTop(0)).toBe(500)
  })
})

// ── W2TC11: vlistBottom / totalHeight 基线链 ────────────────────────

describe('useForkNoticeStream · W2TC11: vlistBottom/totalHeight 基线链', () => {
  it('W2TC11: vlistBottom=1200 + topOffset=44 → forkNoticeTop(0)=1244（1200+44）', () => {
    const { ret } = setup({ vlistBottom: 1200, topOffset: 44 })

    expect(ret.forkNoticeTop(0)).toBe(1244)
    expect(ret.forkNoticeTop(1)).toBe(1284) // 1244 + 40
  })

  it('W2TC11b: 仅 totalHeight=1000 + topOffset=44 → forkNoticeTop(0)=1044（旧路径）', () => {
    const { ret } = setup({ totalHeight: 1000, topOffset: 44 })

    expect(ret.forkNoticeTop(0)).toBe(1044)
  })

  it('W2TC11c: vlistBottom=1200 + totalHeight=1000 → 用 1200（vlistBottom 优先）', () => {
    const { ret } = setup({ vlistBottom: 1200, totalHeight: 1000, topOffset: 0 })

    expect(ret.forkNoticeTop(0)).toBe(1200)
  })

  it('W2TC11d: 无任何基线（totalHeight/vlistBottom/injectedBaseTop 都不传）→ fallback 0', () => {
    const { ret } = setup({ topOffset: 0 })

    // base = 0 ?? 0 ?? 0 = 0；forkNoticeTop(0) = 0 + topOffset(0)
    expect(ret.forkNoticeTop(0)).toBe(0)
  })

  it('vlistBottom + isCompacting=true → forkNoticeTop 叠 compacting 占位（46）', () => {
    const { ret } = setup({ vlistBottom: 1200, topOffset: 0, isCompacting: true })

    // base=1200 + topOffset 0 + compacting 46 = 1246
    expect(ret.forkNoticeTop(0)).toBe(1246)
  })

  it('vlistBottom + isHandingOff=true → 叠 handoff 占位（46）', () => {
    const { ret } = setup({ vlistBottom: 1200, topOffset: 0, isHandingOff: true })

    // base=1200 + topOffset 0 + handoff 46 = 1246
    expect(ret.forkNoticeTop(0)).toBe(1246)
  })

  it('vlistBottom + isDispatching(!hasWorkingTurn) → 叠 dispatching 占位（46）', () => {
    const { ret } = setup({
      vlistBottom: 1200,
      topOffset: 0,
      isDispatching: true,
      hasWorkingTurn: false,
    })

    // base=1200 + topOffset 0 + dispatching 46 = 1246
    expect(ret.forkNoticeTop(0)).toBe(1246)
  })

  it('vlistBottom + isDispatching 但 hasWorkingTurn=true → 不叠 dispatching 占位', () => {
    const { ret } = setup({
      vlistBottom: 1200,
      topOffset: 0,
      isDispatching: true,
      hasWorkingTurn: true,
    })

    // hasWorkingTurn=true → dispatching 占位跳过 → base=1200
    expect(ret.forkNoticeTop(0)).toBe(1200)
  })
})
