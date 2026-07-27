/**
 * useStreamingPin 单测 —— streaming turn 钉扎驱动逻辑（W3 共存防护 + PR#116 review M3 修复）。
 *
 * 测的是真 bug（PR#116 review M3 指出），不是凑覆盖率：
 * - M3-1 挂载时已 streaming：watch 必须 immediate 才施加 pin，否则末 turn streaming 时
 *   pinStreaming 保持 -1 → 用户上滚时 streaming turn 可被卸载（RO 断开高度不更新）
 * - M3-2 跨 session 切换 streaming→streaming：resetSession 清掉 streamingPinIndex=-1，
 *   但旧 session 末 turn 也 streaming → 派生布尔值不变 → 非 session 追踪的 watch 不触发 →
 *   钉扎不重新施加。修复后 watch 源包含 sessionId，强制重钉。
 * - M3-3 flush:post 顺序：resetSession watch（pre flush，注册在 useStreamingPin 之后）
 *   会清 streamingPinIndex。flush:post 让 useStreamingPin 在 reset 之后跑，保证重钉生效。
 * - 回归：streaming=false 释放（-1）；session 切换 streaming→非 streaming 释放。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-streaming-pin.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computed, effectScope, nextTick, ref } from 'vue'
import { useStreamingPin } from '@/composables/panel/useStreamingPin'
import type { RenderItem } from '@/composables/logic/messageTurns'

// flush:post watch 在「DOM 更新后」触发；vue-test 用 nextTick 即可推进。
// happy-dom 无 rAF 依赖（本测不涉及 useVirtualTurnList 的 rAF 节流），fake timers 仅保持一致。
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// ── 测试数据工厂 ────────────────────────────────────────────────────

/** 构造一个 turn RenderItem，isStreaming 可控 */
function turnItem(index: number, key: string, isStreaming = false): RenderItem {
  return {
    kind: 'turn',
    turn: {
      index,
      user: { id: `user-${key}`, role: 'user', content: 'q' } as never,
      assistants: [],
      isStreaming,
      hasFoldable: false,
    },
  }
}

/** 构造一个 system RenderItem（如 bash 消息，排在 streaming turn 之后） */
function systemItem(id: string): RenderItem {
  return {
    kind: 'system',
    message: { id, role: 'system', content: 'bash' } as never,
  }
}

/**
 * 测试用驱动器：把 items（shallowRef 可变）+ sessionId（ref 可变）+ pinStreaming（spy）
 * 喂给 useStreamingPin，返回控制句柄 + 收集的 pinStreaming 调用序列。
 *
 * pinStreaming 用 vi.fn 收集所有调用，便于断言「挂载时立即施加」「切换后重钉」等顺序。
 *
 * [cw wave w2] 扩展：可选 editingTurnIdx（virtua pinnedIndexes 用例需要），返回 pinnedIndexes
 * （useStreamingPin 从 void 改为返回 { pinnedIndexes }）。现有不传 editingTurnIdx 的用例不受影响
 * （setup 仍返回新字段，旧用例不读它即可）。
 */
function setup(opts: {
  items: RenderItem[]
  sessionId?: string
  editingTurnIdx?: ReturnType<typeof ref<number>>
}) {
  const itemsRef = ref(opts.items)
  // 用 ref（非 shallowRef）：测试通过赋值新数组替换整体（identity 变）触发响应式，
  // 模拟生产 renderItems 真 computed 重建（currentMessages 变 → renderItems 重算即新引用）。
  const sessionIdRef = ref(opts.sessionId ?? 'sess-A')
  // editingTurnIdx：外部传入 ref（测试可动态改值触发 pinnedIndexes 重算）；默认不传（undefined）
  const editingTurnIdxRef = opts.editingTurnIdx

  const pinCalls: Array<{ idx: number; at: string }> = []
  const pinStreaming = vi.fn((idx: number) => {
    pinCalls.push({ idx, at: `call-${pinCalls.length}` })
  })

  let pinnedIndexes: ReturnType<typeof useStreamingPin>['pinnedIndexes'] | undefined
  const scope = effectScope()
  scope.run(() => {
    const ret = useStreamingPin({
      items: computed(() => itemsRef.value),
      pinStreaming,
      sessionId: () => sessionIdRef.value,
      editingTurnIdx: editingTurnIdxRef,
    })
    pinnedIndexes = ret.pinnedIndexes
  })

  return { scope, itemsRef, sessionIdRef, pinStreaming, pinCalls, pinnedIndexes }
}

// ── M3-1：挂载时已 streaming → immediate 施加 pin ────────────────────

describe('useStreamingPin · M3-1: 挂载时已 streaming（immediate）', () => {
  it('挂载时末 turn isStreaming=true → 立即 pinStreaming(lastTurnIdx)，不待变化', async () => {
    // 3 个 turn，末 turn streaming；末 turn idx=2
    const { pinCalls } = setup({
      items: [
        turnItem(1, 'k1', false),
        turnItem(2, 'k2', false),
        turnItem(3, 'k3', true),
      ],
    })
    // immediate 回调在 setup 同步执行（与 flush 无关），无需 nextTick
    expect(pinCalls).toHaveLength(1)
    expect(pinCalls[0]!.idx).toBe(2) // lastTurnIdx=2
  })

  it('挂载时无 streaming turn → pinStreaming(-1)（释放，不误钉）', async () => {
    const { pinCalls } = setup({
      items: [
        turnItem(1, 'k1', false),
        turnItem(2, 'k2', false),
      ],
    })
    expect(pinCalls).toHaveLength(1)
    expect(pinCalls[0]!.idx).toBe(-1)
  })

  it('挂载时末 turn streaming 且其后排 bash system item → pin 到 turn 而非 system（跳过末尾 system）', async () => {
    // streaming turn 在 idx=2，bash system item 在 idx=3（共存场景）
    const { pinCalls } = setup({
      items: [
        turnItem(1, 'k1', false),
        turnItem(2, 'k2', false),
        turnItem(3, 'k3', true),
        systemItem('bash-1'),
      ],
    })
    expect(pinCalls[0]!.idx).toBe(2) // 跳过末尾 system item，pin 到 turn idx=2
  })
})

// ── M3-2：跨 session 切换 streaming→streaming → 重钉 ──────────────────

describe('useStreamingPin · M3-2: 跨 session 切换 streaming→streaming（追踪 sessionId）', () => {
  it('session A→B 末 turn 均 streaming → 切换后 pinStreaming 重新施加（lastTurnIdx）', async () => {
    const { itemsRef, sessionIdRef, pinStreaming } = setup({
      items: [turnItem(1, 'k1', false), turnItem(2, 'k2', true)],
      sessionId: 'sess-A',
    })
    // 初始挂载：pin(1)（lastTurnIdx=1）
    expect(pinStreaming).toHaveBeenLastCalledWith(1)

    // 切到 session B：items 替换为新 session 的 turns，末 turn 也 streaming
    // （模拟生产：currentMessages 变 → renderItems 重建；新 session 可能同样 2 turn 末 turn streaming）
    itemsRef.value = [turnItem(1, 'kB1', false), turnItem(2, 'kB2', true)]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    // flush:post 在 DOM 更新后触发，再 nextTick 确保 post 回调落地
    await nextTick()

    // 关键：派生 isStreaming 布尔值未变（A→B 都是 true），但 sessionId 变 → watch 重触发 → 重钉
    expect(pinStreaming).toHaveBeenLastCalledWith(1)
    // 总调用次数：1（mount immediate）+ 1（session 切换重钉）= 2
    expect(pinStreaming).toHaveBeenCalledTimes(2)
  })

  it('session A→B 末 turn 均 streaming 且 turn 数不同 → pin 到新 session 的 lastTurnIdx', async () => {
    const { itemsRef, sessionIdRef, pinStreaming } = setup({
      items: [turnItem(1, 'k1', true)],
      sessionId: 'sess-A',
    })
    expect(pinStreaming).toHaveBeenLastCalledWith(0)

    // 新 session 有 3 个 turn，末 turn streaming → lastTurnIdx=2
    itemsRef.value = [
      turnItem(1, 'kB1', false),
      turnItem(2, 'kB2', false),
      turnItem(3, 'kB3', true),
    ]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    await nextTick()

    expect(pinStreaming).toHaveBeenLastCalledWith(2)
  })
})

// ── M3-3：flush:post 顺序 —— resetSession 后重钉不被覆盖 ───────────────

describe('useStreamingPin · M3-3: flush:post 顺序（resetSession 后重钉）', () => {
  it('模拟 resetSession 在 pre-flush 清 pin 后，useStreamingPin(post) 重钉生效', async () => {
    // 这个测试模拟 MessageStream.vue 的真实结构：
    //   useStreamingPin watch（post flush，注册在前）
    //   resetSession watch（pre flush，注册在后，清 streamingPinIndex=-1）
    // session 切换时 pre-flush 先跑（reset 清 -1），post-flush 后跑（重钉）。
    // 用一个外部 pinIndex 模拟 useVirtualTurnList 的 streamingPinIndex，pinStreaming 写它，
    // 一个 pre-flush watch 模拟 resetSession 清它。
    const { effectScope: es, watch, ref: r, computed: c } = await import('vue')

    let streamingPinIndex = -1
    const sessionIdRef = r('sess-A')
    const itemsRef = r([turnItem(1, 'k1', true)])

    const scope = es()
    const pinCalls: number[] = []
    scope.run(() => {
      // useStreamingPin 等价（post flush）
      useStreamingPin({
        items: c(() => itemsRef.value),
        pinStreaming: (idx) => {
          streamingPinIndex = idx
          pinCalls.push(idx)
        },
        sessionId: () => sessionIdRef.value,
      })
      // resetSession watch 等价（pre flush，注册在 useStreamingPin 之后）
      watch(
        () => sessionIdRef.value,
        () => {
          streamingPinIndex = -1 // resetSession 清零
          pinCalls.push(-1)
        },
        // 默认 pre flush
      )
    })

    // mount：immediate(pin=0)。注：immediate 同步跑，reset watch 非 immediate 不跑。
    expect(pinCalls).toEqual([0])

    // 切 session A→B（均 streaming）
    itemsRef.value = [turnItem(1, 'kB1', true)]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    await nextTick()

    // 顺序应为：reset(-1, pre) → pin(0, post)。最终 streamingPinIndex 应为 0（重钉生效）
    expect(pinCalls).toEqual([0, -1, 0])
    expect(streamingPinIndex).toBe(0) // 重钉生效，未被 reset 覆盖
    scope.stop()
  })
})

// ── 回归：streaming 状态变化与释放 ───────────────────────────────────

describe('useStreamingPin · 回归：streaming 变化与释放', () => {
  it('streaming true→false（同 session）→ pinStreaming(-1) 释放', async () => {
    const { itemsRef, pinStreaming } = setup({
      items: [turnItem(1, 'k1', true)],
    })
    expect(pinStreaming).toHaveBeenLastCalledWith(0)

    // 末 turn streaming 结束
    itemsRef.value = [turnItem(1, 'k1', false)]
    await nextTick()
    await nextTick()

    expect(pinStreaming).toHaveBeenLastCalledWith(-1)
  })

  it('session 切换 streaming→非 streaming → pinStreaming(-1) 释放（不残留旧 pin）', async () => {
    const { itemsRef, sessionIdRef, pinStreaming } = setup({
      items: [turnItem(1, 'k1', true)],
      sessionId: 'sess-A',
    })
    expect(pinStreaming).toHaveBeenLastCalledWith(0)

    // 切到 session B：末 turn 非 streaming
    itemsRef.value = [turnItem(1, 'kB1', false)]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    await nextTick()

    expect(pinStreaming).toHaveBeenLastCalledWith(-1)
  })

  it('空 items（无 turn）→ pinStreaming(-1)，不崩', async () => {
    const { pinStreaming } = setup({ items: [] })
    expect(pinStreaming).toHaveBeenLastCalledWith(-1)
  })
})

// ── W2TC4-W2TC6: pinnedIndexes virtua 路径（多项钉扎输出） ──────────────

describe('useStreamingPin · W2TC4-W2TC6: pinnedIndexes virtua 路径', () => {
  it('W2TC5: streaming lastTurnIdx=5 + editingTurnIdx=2 → pinnedIndexes=[5,2]', () => {
    // 6 个 turn，末 turn（idx=5）streaming
    const items = [
      turnItem(1, 'k0', false),
      turnItem(2, 'k1', false),
      turnItem(3, 'k2', false),
      turnItem(4, 'k3', false),
      turnItem(5, 'k4', false),
      turnItem(6, 'k5', true),
    ]
    const editingTurnIdx = ref(2)
    const { pinnedIndexes } = setup({ items, editingTurnIdx })

    expect(pinnedIndexes!.value).toEqual([5, 2])
  })

  it('W2TC5: 非 streaming → pinnedIndexes 只含 editingTurnIdx=[2]', () => {
    // 末 turn 非 streaming → streamingTurnIdx=-1；只剩 editingTurnIdx=2
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false), turnItem(3, 'k3', false)]
    const editingTurnIdx = ref(2)
    const { pinnedIndexes } = setup({ items, editingTurnIdx })

    expect(pinnedIndexes!.value).toEqual([2])
  })

  it('W2TC6: streaming turn idx === editingTurnIdx → 去重 [3]', () => {
    // 末 turn idx=2 streaming，editingTurnIdx 也=2 → 去重后 [2]
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false), turnItem(3, 'k3', true)]
    const editingTurnIdx = ref(2)
    const { pinnedIndexes } = setup({ items, editingTurnIdx })

    expect(pinnedIndexes!.value).toEqual([2])
  })

  it('W2TC6: 全 -1（无 streaming + 无 editing）→ pinnedIndexes=[]', () => {
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false)]
    const editingTurnIdx = ref(-1)
    const { pinnedIndexes } = setup({ items, editingTurnIdx })

    expect(pinnedIndexes!.value).toEqual([])
  })

  it('W2TC6: 不传 editingTurnIdx + 非 streaming → pinnedIndexes=[]（仅 streaming 驱动）', () => {
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false)]
    const { pinnedIndexes } = setup({ items })

    expect(pinnedIndexes!.value).toEqual([])
  })

  it('W2TC6: 不传 editingTurnIdx + streaming → pinnedIndexes=[lastTurnIdx]', () => {
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', true)]
    const { pinnedIndexes } = setup({ items })

    expect(pinnedIndexes!.value).toEqual([1])
  })

  it('W2TC5: editingTurnIdx 动态变化 → pinnedIndexes 响应式重算', async () => {
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false), turnItem(3, 'k3', false)]
    const editingTurnIdx = ref(-1)
    const { pinnedIndexes } = setup({ items, editingTurnIdx })

    expect(pinnedIndexes!.value).toEqual([])

    editingTurnIdx.value = 1
    await nextTick()
    expect(pinnedIndexes!.value).toEqual([1])

    editingTurnIdx.value = -1
    await nextTick()
    expect(pinnedIndexes!.value).toEqual([])
  })

  it('W2TC4 回归: 传 editingTurnIdx 后 pinStreaming 仍被调用（旧路径不破坏）', () => {
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', true)]
    const editingTurnIdx = ref(0)
    const { pinStreaming } = setup({ items, editingTurnIdx })

    // immediate 回调仍施加 pinStreaming(1)（lastTurnIdx=1）
    expect(pinStreaming).toHaveBeenLastCalledWith(1)
  })
})
