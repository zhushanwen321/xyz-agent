/**
 * useStreamingPin 单测 —— streaming turn 钉扎驱动逻辑（W3 共存防护 + PR#116 review M3 修复）。
 *
 * 测的是真 bug（PR#116 review M3 指出），不是凑覆盖率：
 * - M3-1 挂载时已 streaming：watch 必须 immediate 才能保证 pinnedIndexes 在消费者副作用时机前就绪
 * - M3-2 跨 session 切换 streaming→streaming：watch 源含 sessionId 才能在派生布尔值不变时重新触发
 * - M3-3 flush:post 顺序：resetSession watch（pre flush）清状态后，本 watch（post flush）重钉生效
 *
 * [cw wave w4] 删 pinStreaming 旧路径用例：w3 切到 virtua 后钉扎统一走 pinnedIndexes，
 * 不再有 pinStreaming 回调。M3 用例改为断言 pinnedIndexes（数据源本身正确即可证明钉扎正确——
 * 消费者只读 pinnedIndexes，watch 回调内已无副作用）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-streaming-pin.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computed, effectScope, nextTick, ref } from 'vue'
import { useStreamingPin } from '@/composables/panel/useStreamingPin'
import type { RenderItem } from '@/composables/logic/messageTurns'

// flush:post watch 在「DOM 更新后」触发；vue-test 用 nextTick 即可推进。
// happy-dom 无 rAF 依赖，fake timers 仅保持一致。
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
 * 测试用驱动器：把 items（ref 可变）+ sessionId（ref 可变）喂给 useStreamingPin，
 * 返回控制句柄 + pinnedIndexes（消费者真实读取的钉拽数据源）。
 *
 * [cw wave w4] setup 不再传 pinStreaming（旧路径已删），pinnedIndexes 是唯一钉拽数据源。
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

  let pinnedIndexes: ReturnType<typeof useStreamingPin>['pinnedIndexes'] | undefined
  const scope = effectScope()
  scope.run(() => {
    const ret = useStreamingPin({
      items: computed(() => itemsRef.value),
      sessionId: () => sessionIdRef.value,
      editingTurnIdx: editingTurnIdxRef,
    })
    pinnedIndexes = ret.pinnedIndexes
  })

  return { scope, itemsRef, sessionIdRef, pinnedIndexes }
}

// ── M3-1：挂载时已 streaming → pinnedIndexes 立即含 lastTurnIdx ───────

describe('useStreamingPin · M3-1: 挂载时已 streaming（immediate）', () => {
  it('挂载时末 turn isStreaming=true → pinnedIndexes 立即含 lastTurnIdx', () => {
    // 3 个 turn，末 turn streaming；末 turn idx=2
    const { pinnedIndexes } = setup({
      items: [
        turnItem(1, 'k1', false),
        turnItem(2, 'k2', false),
        turnItem(3, 'k3', true),
      ],
    })
    // pinnedIndexes 是 computed，挂载即就绪（immediate watch 保证下游副作用时机前数据已派生）
    expect(pinnedIndexes!.value).toEqual([2])
  })

  it('挂载时无 streaming turn → pinnedIndexes=[]（释放，不误钉）', () => {
    const { pinnedIndexes } = setup({
      items: [
        turnItem(1, 'k1', false),
        turnItem(2, 'k2', false),
      ],
    })
    expect(pinnedIndexes!.value).toEqual([])
  })

  it('挂载时末 turn streaming 且其后排 bash system item → pin 到 turn 而非 system（跳过末尾 system）', () => {
    // streaming turn 在 idx=2，bash system item 在 idx=3（共存场景）
    const { pinnedIndexes } = setup({
      items: [
        turnItem(1, 'k1', false),
        turnItem(2, 'k2', false),
        turnItem(3, 'k3', true),
        systemItem('bash-1'),
      ],
    })
    // 跳过末尾 system item，pin 到 turn idx=2
    expect(pinnedIndexes!.value).toEqual([2])
  })
})

// ── M3-2：跨 session 切换 streaming→streaming → pinnedIndexes 重新派生 ──

describe('useStreamingPin · M3-2: 跨 session 切换 streaming→streaming（追踪 sessionId）', () => {
  it('session A→B 末 turn 均 streaming → 切换后 pinnedIndexes 含新 session 的 lastTurnIdx', async () => {
    const { itemsRef, sessionIdRef, pinnedIndexes } = setup({
      items: [turnItem(1, 'k1', false), turnItem(2, 'k2', true)],
      sessionId: 'sess-A',
    })
    // 初始挂载：pinnedIndexes=[1]（lastTurnIdx=1）
    expect(pinnedIndexes!.value).toEqual([1])

    // 切到 session B：items 替换为新 session 的 turns，末 turn 也 streaming
    itemsRef.value = [turnItem(1, 'kB1', false), turnItem(2, 'kB2', true)]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    // flush:post 在 DOM 更新后触发，再 nextTick 确保 post 回调落地
    await nextTick()

    // 关键：派生 isStreaming 布尔值未变（A→B 都是 true），但 sessionId 变 → watch 重触发 → 重钉
    expect(pinnedIndexes!.value).toEqual([1])
  })

  it('session A→B 末 turn 均 streaming 且 turn 数不同 → pin 到新 session 的 lastTurnIdx', async () => {
    const { itemsRef, sessionIdRef, pinnedIndexes } = setup({
      items: [turnItem(1, 'k1', true)],
      sessionId: 'sess-A',
    })
    expect(pinnedIndexes!.value).toEqual([0])

    // 新 session 有 3 个 turn，末 turn streaming → lastTurnIdx=2
    itemsRef.value = [
      turnItem(1, 'kB1', false),
      turnItem(2, 'kB2', false),
      turnItem(3, 'kB3', true),
    ]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    await nextTick()

    expect(pinnedIndexes!.value).toEqual([2])
  })
})

// ── 回归：streaming 状态变化与释放 ───────────────────────────────────

describe('useStreamingPin · 回归：streaming 变化与释放', () => {
  it('streaming true→false（同 session）→ pinnedIndexes=[]（释放）', async () => {
    const { itemsRef, pinnedIndexes } = setup({
      items: [turnItem(1, 'k1', true)],
    })
    expect(pinnedIndexes!.value).toEqual([0])

    // 末 turn streaming 结束
    itemsRef.value = [turnItem(1, 'k1', false)]
    await nextTick()
    await nextTick()

    expect(pinnedIndexes!.value).toEqual([])
  })

  it('session 切换 streaming→非 streaming → pinnedIndexes=[]（不残留旧 pin）', async () => {
    const { itemsRef, sessionIdRef, pinnedIndexes } = setup({
      items: [turnItem(1, 'k1', true)],
      sessionId: 'sess-A',
    })
    expect(pinnedIndexes!.value).toEqual([0])

    // 切到 session B：末 turn 非 streaming
    itemsRef.value = [turnItem(1, 'kB1', false)]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    await nextTick()

    expect(pinnedIndexes!.value).toEqual([])
  })

  it('空 items（无 turn）→ pinnedIndexes=[]，不崩', () => {
    const { pinnedIndexes } = setup({ items: [] })
    expect(pinnedIndexes!.value).toEqual([])
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
})
