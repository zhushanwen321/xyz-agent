/**
 * useMessageStreamRail 双轨单测（cw wave w2 / W2TC1-W2TC3）。
 *
 * 验证 vlistRef 可选入参的双轨行为：
 * - W2TC1 不传 vlistRef → onJump 写 scrollEl.scrollTop（旧路径，offsetOf + topOffset 公式）
 * - W2TC2 传 mock vlistRef → onJump 调 vlist.scrollToIndex(renderIdx, {align:'start'})，不写 scrollTop
 * - W2TC2 传 mock vlistRef → updateActiveTurnIndex 调 vlist.findItemIndex(scrollOffset)
 * - W2TC3 传 vlistRef=ref(null) → onJump/updateActiveTurnIndex fallback 旧路径（virtua 未就绪）
 *
 * mock 策略：用 createMockVlist 造满足 VirtualizerHandle 接口的 mock，注入 vlistRef。
 * composable 内 onMounted/onScopeDispose 需 active component instance，用 host 组件包裹
 * （参考 MessageStream.wire.test.ts:261-288 的 mountRail helper）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-message-stream-rail-virtua.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, ref, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { VirtualizerHandle } from 'virtua/vue'
import { useMessageStreamRail } from '@/composables/panel/useMessageStreamRail'
import type { MessageTurn, RenderItem } from '@/composables/logic/messageTurns'
import { createMockVlist } from './_virtua-mock-helper'

// ── 测试数据工厂 ────────────────────────────────────────────────────

/** 构造一个 turn RenderItem（index 可控）。 */
function turnItem(index: number): RenderItem {
  return {
    kind: 'turn',
    turn: {
      index,
      user: { id: `u${index}`, role: 'user', content: 'q' } as never,
      assistants: [],
      isStreaming: false,
      hasFoldable: false,
    } as MessageTurn,
  }
}

/** 构造 3 个 turn 的 renderItems（rail 索引空间 = 3 turns，renderItems 下标 0/1/2）。 */
function makeRenderItems(): RenderItem[] {
  return [turnItem(1), turnItem(2), turnItem(3)]
}

/**
 * mount 一个 host 组件，setup 内调 useMessageStreamRail（composable 内 onMounted/onScopeDispose
 * 需 active component instance，用 host 组件包裹避免「no active effect scope」warning）。
 * 返回 rail composable 返回值 + host wrapper（unmount 触发 onScopeDispose 清理）。
 *
 * 参考 MessageStream.wire.test.ts:261-288 的 mountRail helper 构造 deps。
 */
function mountRail(opts: {
  renderItems?: RenderItem[]
  scrollEl?: HTMLElement | null
  offsetOf?: (idx: number) => number
  topOffset?: number
  vlistRef?: Ref<VirtualizerHandle | null>
}): { rail: ReturnType<typeof useMessageStreamRail>; wrapper: ReturnType<typeof mount> } {
  const sessionId = computed(() => 's-rail-virtua-test')
  const renderItemsRef = ref<RenderItem[]>(opts.renderItems ?? makeRenderItems())
  const scrollElRef = ref<HTMLElement | null>(opts.scrollEl ?? null)
  const offsetOfFn = opts.offsetOf ?? ((idx: number) => idx * 100)
  const topOffset = computed(() => opts.topOffset ?? 0)
  let rail!: ReturnType<typeof useMessageStreamRail>
  const Host = defineComponent({
    setup() {
      rail = useMessageStreamRail({
        sessionId,
        renderItems: renderItemsRef,
        scrollEl: scrollElRef,
        offsetOf: offsetOfFn,
        topOffset,
        vlistRef: opts.vlistRef,
      })
      return () => h('div')
    },
  })
  const wrapper = mount(Host, { global: { plugins: [createPinia()] } })
  return { rail, wrapper }
}

/** 造一个有真实 scrollTop/scrollHeight/clientHeight 的 mock scrollEl（happy-dom 下 div 即可）。 */
function makeScrollEl(): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { writable: true, value: 0 })
  Object.defineProperty(el, 'scrollHeight', { writable: true, value: 600 })
  Object.defineProperty(el, 'clientHeight', { writable: true, value: 200 })
  return el
}

beforeEach(() => {
  setActivePinia(createPinia())
})

// ── W2TC1: 不传 vlistRef → 旧路径（scrollTop 写入） ──────────────────

describe('useMessageStreamRail · W2TC1: 不传 vlistRef（旧路径）', () => {
  it('onJump 写 scrollEl.scrollTop = offsetOf(renderIdx) + topOffset（不调 virtua）', () => {
    const scrollEl = makeScrollEl()
    // offsetOf(idx) = idx*100，rail jump idx=1 → renderItems 下标也是 1 → offsetOf(1)=100
    // topOffset=44 → scrollTop 应 = 144
    const { rail } = mountRail({ scrollEl, topOffset: 44, offsetOf: (i) => i * 100 })

    rail.onJump(1)

    expect(scrollEl.scrollTop).toBe(144)
  })

  it('onJump 不传 topOffset（默认 0）→ scrollTop = offsetOf(renderIdx)', () => {
    const scrollEl = makeScrollEl()
    const { rail } = mountRail({ scrollEl, offsetOf: (i) => i * 50 })

    rail.onJump(2) // renderIdx=2 → offsetOf(2)=100

    expect(scrollEl.scrollTop).toBe(100)
  })

  it('updateActiveTurnIndex 按 scrollTop 比例推算 activeTurnIndex（旧路径）', () => {
    const scrollEl = makeScrollEl()
    // scrollHeight=600/clientHeight=200 → max=400；scrollTop=200 → ratio=0.5
    // railTurns.length=3 → floor(0.5*3)=1
    const { rail } = mountRail({ scrollEl })
    scrollEl.scrollTop = 200

    rail.updateActiveTurnIndex()

    expect(rail.activeTurnIndex.value).toBe(1)
  })
})

// ── W2TC2: 传 mock vlistRef → virtua 路径 ──────────────────────────

describe('useMessageStreamRail · W2TC2: 传 mock vlistRef（virtua 路径）', () => {
  it('onJump 调 vlist.scrollToIndex(renderIdx, {align:"start"})，不写 scrollEl.scrollTop', () => {
    const scrollEl = makeScrollEl()
    const mock = createMockVlist()
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail } = mountRail({ scrollEl, vlistRef, topOffset: 44, offsetOf: (i) => i * 100 })

    rail.onJump(1) // renderItems 下标=1

    expect(mock.scrollToIndex).toHaveBeenCalledWith(1, { align: 'start' })
    // 旧路径未被触发：scrollTop 保持初始 0
    expect(scrollEl.scrollTop).toBe(0)
  })

  it('updateActiveTurnIndex 调 vlist.findItemIndex(v.scrollOffset)，写 activeTurnIndex', () => {
    const scrollEl = makeScrollEl()
    // findItemIndex mock：返回固定 2（模拟 vlist 当前可见首项）
    const findItemIndex = vi.fn(() => 2)
    const mock = createMockVlist({ scrollOffset: 500, findItemIndex })
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail } = mountRail({ scrollEl, vlistRef })

    rail.updateActiveTurnIndex()

    expect(findItemIndex).toHaveBeenCalledWith(500)
    expect(rail.activeTurnIndex.value).toBe(2)
    // 不读 scrollEl 比例（旧路径不应被触发）
  })

  it('onJump rail idx 映射回 renderItems 下标（系统提示行穿插场景）', () => {
    // renderItems = [system, turn1, system, turn2, turn3]：railTurns=[turn1,turn2,turn3]
    // rail idx=2（turn3）→ renderItems 下标=4
    const renderItems: RenderItem[] = [
      { kind: 'system', message: { id: 's1', role: 'system', content: 'x' } as never },
      turnItem(1),
      { kind: 'system', message: { id: 's2', role: 'system', content: 'y' } as never },
      turnItem(2),
      turnItem(3),
    ]
    const scrollEl = makeScrollEl()
    const mock = createMockVlist()
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail } = mountRail({ renderItems, scrollEl, vlistRef })

    rail.onJump(2) // rail idx 2 = turn3 → renderItems 下标 4

    expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'start' })
  })
})

// ── W2TC3: 传 vlistRef=ref(null) → fallback 旧路径（virtua 未就绪） ────

describe('useMessageStreamRail · W2TC3: vlistRef=ref(null) fallback 旧路径', () => {
  it('onJump vlistRef.value=null → 写 scrollEl.scrollTop（旧路径）', () => {
    const scrollEl = makeScrollEl()
    const vlistRef = ref<VirtualizerHandle | null>(null)
    const { rail } = mountRail({ scrollEl, vlistRef, topOffset: 10, offsetOf: (i) => i * 100 })

    rail.onJump(1) // offsetOf(1)=100 + topOffset 10 = 110

    expect(scrollEl.scrollTop).toBe(110)
  })

  it('updateActiveTurnIndex vlistRef.value=null → 比例推算（旧路径）', () => {
    const scrollEl = makeScrollEl()
    const vlistRef = ref<VirtualizerHandle | null>(null)
    const { rail } = mountRail({ scrollEl, vlistRef })
    scrollEl.scrollTop = 400 // ratio=1.0 → floor(1.0*3)=3 → clamp to length-1=2

    rail.updateActiveTurnIndex()

    expect(rail.activeTurnIndex.value).toBe(2)
  })
})
