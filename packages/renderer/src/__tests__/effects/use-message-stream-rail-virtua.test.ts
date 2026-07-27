/**
 * useMessageStreamRail 单测（cw wave w4 / W2TC2）。
 *
 * [cw wave w4] 单一 virtua 路径：vlistRef 必填，onJump/updateActiveTurnIndex 都走 virta API。
 * 保留 W2TC2（virtua 路径）用例；W2TC1（旧路径 scrollTop 写入）/ W2TC3（null fallback）随
 * offsetOf/topOffset 删除 + vlistRef 必填化而移除（virta handle 由消费方保证挂载后注入）。
 *
 * 验证：
 * - W2TC2 传 mock vlistRef → onJump 调 vlist.scrollToIndex(renderIdx, {align:'start'})
 * - W2TC2 传 mock vlistRef → updateActiveTurnIndex 调 vlist.findItemIndex(scrollOffset)
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
 * [cw wave w4] vlistRef 必填：默认注入 createMockVlist()，virtua 路径专用。
 */
function mountRail(opts: {
  renderItems?: RenderItem[]
  scrollEl?: HTMLElement | null
  vlistRef?: Ref<VirtualizerHandle | null>
}): { rail: ReturnType<typeof useMessageStreamRail>; wrapper: ReturnType<typeof mount> } {
  const sessionId = computed(() => 's-rail-virtua-test')
  const renderItemsRef = ref<RenderItem[]>(opts.renderItems ?? makeRenderItems())
  const scrollElRef = ref<HTMLElement | null>(opts.scrollEl ?? null)
  const vlistRef = opts.vlistRef ?? ref<VirtualizerHandle | null>(createMockVlist())
  let rail!: ReturnType<typeof useMessageStreamRail>
  const Host = defineComponent({
    setup() {
      rail = useMessageStreamRail({
        sessionId,
        renderItems: renderItemsRef,
        scrollEl: scrollElRef,
        vlistRef,
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

// ── W2TC2: 传 mock vlistRef → virtua 路径 ──────────────────────────

describe('useMessageStreamRail · W2TC2: 传 mock vlistRef（virtua 路径）', () => {
  it('onJump 调 vlist.scrollToIndex(renderIdx, {align:"start"})', () => {
    const scrollEl = makeScrollEl()
    const mock = createMockVlist()
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail } = mountRail({ scrollEl, vlistRef })

    rail.onJump(1) // renderItems 下标=1

    expect(mock.scrollToIndex).toHaveBeenCalledWith(1, { align: 'start' })
  })

  it('updateActiveTurnIndex 调 vlist.findItemIndex(v.scrollOffset)，写 activeTurnIndex', () => {
    // findItemIndex mock：返回固定 2（模拟 vlist 当前可见首项）
    const findItemIndex = vi.fn(() => 2)
    const mock = createMockVlist({ scrollOffset: 500, findItemIndex })
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail } = mountRail({ vlistRef })

    rail.updateActiveTurnIndex()

    expect(findItemIndex).toHaveBeenCalledWith(500)
    expect(rail.activeTurnIndex.value).toBe(2)
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

  it('[cw wave w4] vlistRef.value=null（首帧未挂载）→ onJump/updateActiveTurnIndex 早返回 no-op', () => {
    // vlistRef 必填但 value 可能为 null（首帧未挂载 / session 切换 dispose）：composable 不抛错，no-op。
    const scrollEl = makeScrollEl()
    const vlistRef = ref<VirtualizerHandle | null>(null)
    const { rail } = mountRail({ scrollEl, vlistRef })

    expect(() => rail.onJump(1)).not.toThrow()
    expect(() => rail.updateActiveTurnIndex()).not.toThrow()
    // activeTurnIndex 保持初始 0（未调 findItemIndex）
    expect(rail.activeTurnIndex.value).toBe(0)
  })
})
