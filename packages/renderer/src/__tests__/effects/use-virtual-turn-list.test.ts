/**
 * useVirtualTurnList 单测 —— 虚拟滚动核心算法（W1 纯逻辑层）。
 *
 * 测的是真 bug，不是凑覆盖率：
 * - computeWindow 二分查找定位（防窗口错位致白屏/内容缺失）
 * - heights 用首消息 id 键（防 truncateFrom 重排后 t-index 张冠李戴，SR1）
 * - offsets 前缀和一致性（防 spacer 高度错致滚动条跳跃 + scrollToBottom 滚不到底，INVAR-3）
 * - 估算→实测视口锚定（防视口上方 turn 测量后用户所见内容跳，SR4/INVAR-2）
 * - 末项钉扎（防流式末项滚出视口不挂载 RO 不上报高度停估算 sticky-bottom 失准，SR3/INVAR-10）
 * - editing 钉扎（防 lastUserTurn 滚出视口 draftText 丢失，SR5）
 * - 空态（防 renderItems 空 totalHeight NaN/负值，SR12/INVAR-9）
 * - session 切换重置（防不同 session heights 残留错位，SR10/INVAR-8）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-virtual-turn-list.test.ts
 *
 * [红灯说明] useVirtualTurnList 尚未实现，import 会失败 → 测试红灯。W1 实现后转绿。
 */
import { describe, it, expect } from 'vitest'
import { effectScope, nextTick, shallowRef, triggerRef } from 'vue'
import { useVirtualTurnList } from '@/composables/effects/useVirtualTurnList'
import type { RenderItem } from '@/composables/logic/messageTurns'

// ── 测试数据工厂 ────────────────────────────────────────────────────

/** 构造一个 turn RenderItem，首消息 id 由 turnKey 决定（模拟首消息 id 键策略） */
function turnItem(index: number, key: string): RenderItem {
  return {
    kind: 'turn',
    turn: {
      index,
      user: { id: `user-${key}`, role: 'user', content: 'q' } as never,
      assistants: [],
      isWorking: false,
      hasFoldable: false,
    },
  }
}

/** 构造 N 个 turn 的 renderItems */
function makeItems(n: number): RenderItem[] {
  const items: RenderItem[] = []
  for (let i = 1; i <= n; i++) items.push(turnItem(i, `k${i}`))
  return items
}

/** mock scrollEl：可控 scrollTop/clientHeight/scrollHeight */
function mockScrollEl(scrollTop: number, viewportHeight: number): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop })
  Object.defineProperty(el, 'clientHeight', { configurable: true, writable: true, value: viewportHeight })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, writable: true, value: 99999 })
  return el
}

/**
 * 测试用 composable 驱动器。
 * useVirtualTurnList 接收 renderItems + scrollEl + viewportHeight，暴露：
 * - totalHeight（撑 spacer）
 * - visibleRange { startIndex, endIndex }（窗口）
 * - reportHeight(key, h)（RO 上报入口）
 * - scrollAdjustDelta（视口锚定补偿量，供测试断言）
 */
async function setup(opts: {
  items?: RenderItem[]
  scrollTop?: number
  viewportHeight?: number
  buffer?: number
}) {
  // items 用 shallowRef 包裹：真 computed（totalHeight/visibleRange/layout）依赖 items()，
  // 测试对数组做 splice（模拟 truncateFrom / 每 token 重建）后需 triggerRef 触发失效，
  // 否则 computed 不知数组内容变了（生产侧 renderItems 是真 computed，重建即失效，无需此处理）。
  const itemsRef = shallowRef(opts.items ?? makeItems(20))
  const scope = effectScope()
  const scrollEl = mockScrollEl(opts.scrollTop ?? 0, opts.viewportHeight ?? 600)
  let state!: ReturnType<typeof useVirtualTurnList>
  scope.run(() => {
    state = useVirtualTurnList({
      items: () => itemsRef.value,
      scrollEl: () => scrollEl,
      estimatedHeight: () => 200,
      buffer: () => opts.buffer ?? 1,
    })
  })
  // 同步初始 scrollTop/viewportHeight 进响应式 ref：visibleRange 是真 computed，
  // 需 onScrollUpdate 把 DOM 的 scrollTop/clientHeight 写入 ref 才能基于真实视口算窗口。
  state.onScrollUpdate()
  await nextTick()
  return { state, scope, scrollEl, items: itemsRef.value, itemsRef }
}

// ── computeWindow 二分查找定位 ──────────────────────────────────────

describe('useVirtualTurnList · computeWindow（AC-2）', () => {
  it('scrollTop=0 时 startIndex=0，endIndex 覆盖视口加 buffer', async () => {
    // 20 turn 各 200px，viewport 600px（容 3 turn），buffer 1（上下各 1 turn）
    // 顶部：startIndex=0。
    // endIndex 受末项钉扎（INVAR-10：endIndex=max(computedEnd, lastIndex) 恒成立）
    // → 即使 scrollTop=0 也强制 = lastIndex（19），与「末项钉扎」测试组同源。
    const { state } = await setup({ items: makeItems(20), scrollTop: 0, viewportHeight: 600, buffer: 1 })
    expect(state.visibleRange.value.startIndex).toBe(0)
    expect(state.visibleRange.value.endIndex).toBe(19)
  })

  it('scrollTop 在中间时 startIndex 定位到正确 turn', async () => {
    // 20 turn 各 200px，滚到 scrollTop=2000（第 10 个 turn 顶部），viewport 600
    const { state } = await setup({ items: makeItems(20), scrollTop: 2000, viewportHeight: 600, buffer: 1 })
    // 第 10 turn 顶部在 1800（index 9，offsets[9]=9*200=1800），scrollTop=2000 在 turn index 10 内
    // startIndex 应 <= 10（含 buffer 上移），不能跳到 11+
    expect(state.visibleRange.value.startIndex).toBeLessThanOrEqual(10)
    expect(state.visibleRange.value.startIndex).toBeGreaterThanOrEqual(9)
  })

  it('scrollTop 接近底部时 endIndex=lastIndex（覆盖末尾）', async () => {
    // 20 turn 各 200px，总高 4000，scrollTop=3800（近底），viewport 600
    const { state } = await setup({ items: makeItems(20), scrollTop: 3800, viewportHeight: 600, buffer: 1 })
    expect(state.visibleRange.value.endIndex).toBe(19) // lastIndex
  })
})

// ── heights 首消息 id 键 + offsets 前缀和 ─────────────────────────────

describe('useVirtualTurnList · heights/offsets（AC-3, SR1 首消息 id 键）', () => {
  it('RO 上报高度后 heights 更新 + offsets 前缀和重算（INVAR-3 等式守恒）', async () => {
    const { state } = await setup({ items: makeItems(5), scrollTop: 0, viewportHeight: 600 })
    // 初始全估算 200px，totalHeight = 5*200 = 1000
    expect(state.totalHeight.value).toBe(1000)
    // 上报 turn 0（首消息 id user-k1）实测 300px
    state.reportHeight('user-k1', 300)
    await nextTick()
    // totalHeight = 300 + 4*200 = 1100
    expect(state.totalHeight.value).toBe(1100)
  })

  it('SR1: 用首消息 id 键非 t-index——renderItems 重建数组身份后同键高度保留', async () => {
    const items = makeItems(5)
    const { state, itemsRef } = await setup({ items, scrollTop: 0, viewportHeight: 600 })
    state.reportHeight('user-k1', 300)
    await nextTick()
    // 模拟 commitMessages 每 token 重建数组身份（新数组对象，同内容）。
    // 生产侧 renderItems 是真 computed 重建即触发；测试用 shallowRef，splice 后手动 triggerRef。
    itemsRef.value.splice(0, itemsRef.value.length, ...makeItems(5))
    triggerRef(itemsRef)
    await nextTick()
    // 同首消息 id（user-k1）高度应保留 300，不回退为估算 200
    expect(state.totalHeight.value).toBe(1100) // 300 + 4*200
  })

  it('truncateFrom 后被移除 turn 的高度失效（首消息 id 不在新 items 自然清除）', async () => {
    const items = makeItems(5)
    const { state, itemsRef } = await setup({ items, scrollTop: 0, viewportHeight: 600 })
    state.reportHeight('user-k1', 300)
    state.reportHeight('user-k3', 500)
    await nextTick()
    // totalHeight = 300 + 200 + 500 + 200 + 200 = 1400
    expect(state.totalHeight.value).toBe(1400)
    // truncate：移除后 3 个 turn（k3,k4,k5），只留前 2 个（k1,k2）
    // 生产侧 renderItems 是真 computed（truncateFrom→currentMessages 变→renderItems 重算即失效）；
    // 测试用 shallowRef，splice 后手动 triggerRef 通知 computed 重算。
    itemsRef.value.splice(2) // 只留前 2 项
    triggerRef(itemsRef)
    await nextTick()
    // totalHeight = 300 + 200 = 500（k3 的 500 已失效，不在新 items）
    expect(state.totalHeight.value).toBe(500)
  })
})

// ── offsets 前缀和定位（offsetOf） ───────────────────────────────────

describe('useVirtualTurnList · offsetOf 前缀和定位', () => {
  it('offsetOf(i) 返回 turn i 的顶部偏移（前缀和，随实测高度更新）', async () => {
    const { state } = await setup({ items: makeItems(5), scrollTop: 0, viewportHeight: 600 })
    // 初始全估算 200：offsets=[0,200,400,600,800]
    expect(state.offsetOf(0)).toBe(0)
    expect(state.offsetOf(1)).toBe(200)
    expect(state.offsetOf(2)).toBe(400)
    // 上报 turn1（makeItems 第 2 项，key=user-k2）实测 300，后续 offset 偏移
    state.reportHeight('user-k2', 300)
    await nextTick()
    // offsets=[0,200,500,700,900]——turn0 高度不变，turn1 之后整体后移 100
    expect(state.offsetOf(1)).toBe(200) // turn0 高 200 不变
    expect(state.offsetOf(2)).toBe(500) // 200 + 300
    expect(state.offsetOf(3)).toBe(700) // 500 + 200
  })
})

// ── 估算→实测视口锚定（SR4/INVAR-2） ─────────────────────────────────

describe('useVirtualTurnList · 估算→实测视口锚定（AC-4, SR4）', () => {
  it('视口上方 turn 首次实测时 scrollTop 补偿差值（防用户所见内容跳）', async () => {
    // 10 turn 各估算 200px，scrollTop=1000（看着 turn 5），viewport 600
    const { state, scrollEl } = await setup({ items: makeItems(10), scrollTop: 1000, viewportHeight: 600 })
    // turn 0 在视口上方（offsets[0]+heights[0]=200 <= scrollTop=1000）
    // 上报 turn 0 实测 400px（比估算多 200），应补偿 scrollTop += 200
    state.reportHeight('user-k1', 400)
    await nextTick()
    // scrollAdjustDelta 暴露本次补偿量供测试断言（+200）
    expect(state.scrollAdjustDelta.value).toBe(200)
  })

  it('视口内 turn 首次实测时不补偿（或补偿 0，视口内跳跃可接受但不应反向）', async () => {
    const { state } = await setup({ items: makeItems(10), scrollTop: 1000, viewportHeight: 600 })
    // turn 5 在视口内（offsets[5]=1000 在 [1000, 1600) 内）
    state.reportHeight('user-k6', 400)
    await nextTick()
    // 视口内不补偿（防补偿引入额外跳动）
    expect(state.scrollAdjustDelta.value).toBe(0)
  })

  it('B10: 同帧多次视口上方 turn 上报 → delta 累加（防末次覆盖中间值）', async () => {
    // 10 turn 各估算 200px，scrollTop=1000（看着 turn 5），viewport 600。
    // turn 0、turn 1 均在视口上方（offsets[0]+200=200 <= 1000，offsets[1]+200=400 <= 1000）。
    const { state } = await setup({ items: makeItems(10), scrollTop: 1000, viewportHeight: 600 })
    // turn 0 实测 400（比估算多 200）→ +200
    state.reportHeight('user-k1', 400)
    // turn 1 实测 300（比估算多 100）→ +100
    // 旧逻辑（覆盖）：delta=100（末次覆盖首次的 200）→ 首次补偿丢失致内容跳。
    // 新逻辑（累加）：delta=200+100=300（两者都补偿，调用方应用后清零）。
    state.reportHeight('user-k2', 300)
    await nextTick()
    expect(state.scrollAdjustDelta.value).toBe(300)
  })
})

// ── 末项钉扎（SR3/INVAR-10） ─────────────────────────────────────────

describe('useVirtualTurnList · 末项钉扎（SR3, INVAR-10）', () => {
  it('scrollTop=0（顶部）时 endIndex 仍 >= lastIndex（末项强制在窗口内）', async () => {
    // 20 turn 各 200px，viewport 600，buffer 1。正常窗口只到 index 4-5，
    // 但末项（index 19）必须钉扎在窗口内（否则不挂载 RO 不上报 sticky-bottom 失准）
    const { state } = await setup({ items: makeItems(20), scrollTop: 0, viewportHeight: 600, buffer: 1 })
    expect(state.visibleRange.value.endIndex).toBe(19) // lastIndex
  })
})

// ── editing 钉扎（SR5） ──────────────────────────────────────────────

describe('useVirtualTurnList · editing 钉扎（SR5）', () => {
  it('lastUserTurnIdx 钉扎：startIndex 不超过 lastUserTurnIdx（防 draftText 丢失）', async () => {
    // 20 turn，lastUserTurnIdx=15（倒数第 5），scrollTop 极大（滚到底部）
    const items = makeItems(20)
    const { state } = await setup({ items, scrollTop: 99999, viewportHeight: 600, buffer: 1 })
    // 设置 editing 钉扎目标
    state.pinEditing(15)
    await nextTick()
    // startIndex 不能超过 15（否则 turn 15 滚出视口卸载 draftText 丢失）
    expect(state.visibleRange.value.startIndex).toBeLessThanOrEqual(15)
  })
})

// ── 空态（SR12/INVAR-9） ─────────────────────────────────────────────

describe('useVirtualTurnList · 空态（SR12, INVAR-9）', () => {
  it('renderItems 为空时 totalHeight=0 + visibleRange={0,-1}（不得 NaN/负值，空循环语义清晰）', async () => {
    const { state } = await setup({ items: [], scrollTop: 0, viewportHeight: 600 })
    expect(state.totalHeight.value).toBe(0)
    expect(Number.isFinite(state.totalHeight.value)).toBe(true)
    // visibleRange 空态早返回 {0,-1}：调用方 `i(0) <= -1` 为 false → 空循环（与 n=1 正常路径区分）
    expect(state.visibleRange.value).toEqual({ startIndex: 0, endIndex: -1 })
  })
})

// ── session 切换重置（SR10/INVAR-8） ─────────────────────────────────

describe('useVirtualTurnList · session 切换重置（SR10, INVAR-8）', () => {
  it('resetSession 后 heights Map 真被清空（非仅 totalHeight 重算）——视口上方 report 走 estimated 基准', async () => {
    // scrollTop=2000，turn0 在视口上方（offsets[0]=0，turnBottom=200 <= 2000），命中 SR4 视口锚定补偿分支。
    // scrollAdjustDelta = h - old；old 取自 heights Map（无则 estimated=200）。
    // 通过比较「reset 前后同 key 同高度的 delta」区分 Map 是否清空：
    //   - Map 清空：old 回到 estimated(200)，delta=400-200=200
    //   - Map 残留：old=旧实测(400)，delta=400-400=0
    const { state } = await setup({ items: makeItems(20), scrollTop: 2000, viewportHeight: 600 })

    // 首次上报 turn0 = 300：old=estimated(200) → delta=100
    state.reportHeight('user-k1', 300)
    await nextTick()
    expect(state.scrollAdjustDelta.value).toBe(100)
    // B10：reportHeight 累积 delta，调用方应用后清零（模拟 MessageStream watch 消费行为）
    state.scrollAdjustDelta.value = 0

    // 再次上报 turn0 = 400：old=300（Map 已有）→ delta=100
    state.reportHeight('user-k1', 400)
    await nextTick()
    expect(state.scrollAdjustDelta.value).toBe(100)
    state.scrollAdjustDelta.value = 0

    // resetSession：heights Map 应清空（SR10/INVAR-8）
    state.resetSession()
    await nextTick()

    // 重新上报 turn0 = 400：Map 清空后 old 回到 estimated(200) → delta=200
    // 若 Map 未清空：old=400 → delta=0。此断言能真正区分 Map 是否清空。
    state.reportHeight('user-k1', 400)
    await nextTick()
    expect(state.scrollAdjustDelta.value).toBe(200)
  })
})
