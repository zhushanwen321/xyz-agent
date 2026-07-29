/**
 * useMessageStreamScroll 单测 —— MessageStream 的滚动触发编排。
 *
 * [cw wave w3 / IF4] scrollToBottom 签名从 `(behavior, force?)` 改为 `(force?) => void`：
 * MessageStream.vue 传入 followIfStuck / followToBottom 联合（virta 单一 scrollTop owner）。
 * 本测 mock scrollToBottom 断言 force 参数：MS4/MS6 force=true（onMounted 强制），
 * 其余 force=undefined（默认走 stickToBottom guard）。
 *
 * 重点覆盖 fix-finish-scroll L2 的「对话完成滚动」watch：
 *   watch(isSessionActive, (nw, old) => { if (old && !nw) scrollToBottom() })
 *
 * 背景：对话完成时 trace 自动折叠（useTurnElapsed.onComplete 驱动 expanded=false）致末尾 turn
 * 高度骤减，virta $fixScrollJump 异步触发 followIfStuck 有时间窗，期间界面停中间。
 * 此处与 trace 折叠同源（都看 isSessionActive）显式补一次 follow，消除空窗期。
 *
 * 覆盖：
 * - MS1：isSessionActive true→false（对话真正结束）→ scrollToBottom() 被调用一次（force=undefined）
 * - MS2：isSessionActive false→true（新对话开始）→ 不调用 scrollToBottom（防误触发）
 * - MS3：isSessionActive 恒 true（ask-user respond 后仍进行中）→ 不调用
 * - MS4：挂载即滚到底（onMounted → scrollToBottom(true)，force=true，与 stick guard 无关）
 * - MS5：消息条数变化 → scrollToBottom()（既有触发源回归，force=undefined）
 * - MS6：完成滚动用 force=undefined（尊重 stickToBottom guard，用户上滑时不强行拉回）
 *
 * 测试基建：useMessageStreamScroll 内部用 onMounted + watch，必须在组件 setup 作用域调用，
 * 故用 @vue/test-utils 挂载一个 Host 组件（setup 内调 composable，refs 经闭包从测试传入）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-message-stream-scroll.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, ref, type Ref, type ComputedRef } from 'vue'
import { useMessageStreamScroll } from '@/composables/panel/useMessageStreamScroll'
import type { Message } from '@xyz-agent/shared'

/**
 * 构造测试 deps + Host 组件。
 *
 * 所有 ComputedRef deps 从可变 refs 派生，测试改 ref.value 即可驱动 watch。
 * scrollToBottom 是 vi.fn()，断言调用次数/参数。
 *
 * 返回 holder：测试通过 holder 控制 refs 并读取 scrollToBottom mock。
 */
interface ScrollDepsHolder {
  currentMessages: Ref<Message[]>
  lastRenderTurn: Ref<{ isStreaming: boolean } | null>
  isCompacting: Ref<boolean>
  isHandingOff: Ref<boolean>
  isSessionActive: Ref<boolean>
  scrollToBottom: ReturnType<typeof vi.fn>
}

function makeDepsHolder(initial: {
  messages?: Message[]
  isSessionActive?: boolean
} = {}): ScrollDepsHolder {
  const msg = (id: string, content: string): Message =>
    ({ id, role: 'assistant', content, status: 'complete', timestamp: Date.now() } as Message)
  return {
    currentMessages: ref<Message[]>(initial.messages ?? [msg('a1', 'hello')]),
    lastRenderTurn: ref<{ isStreaming: boolean } | null>({ isStreaming: false }),
    isCompacting: ref(false),
    isHandingOff: ref(false),
    isSessionActive: ref(initial.isSessionActive ?? false),
    scrollToBottom: vi.fn(),
  }
}

/**
 * 把 Ref 包装成 ComputedRef（useMessageStreamScroll 的 deps 类型要求 ComputedRef）。
 * computed 包装透传 ref.value，watch 能正常响应 ref 变化。
 */
function toComputed<T>(r: Ref<T>): ComputedRef<T> {
  return computed(() => r.value)
}

/**
 * 挂载 Host 组件调用 useMessageStreamScroll。
 *
 * Host 的 setup 内把 holder 的 refs 包成 ComputedRef 后传入 composable，
 * 挂载即触发 onMounted（→ scrollToBottom('auto', true)）。
 */
function mountScroll(holder: ScrollDepsHolder) {
  const Host = defineComponent({
    name: 'ScrollHost',
    setup() {
      useMessageStreamScroll({
        currentMessages: toComputed(holder.currentMessages),
        lastRenderTurn: toComputed(holder.lastRenderTurn),
        isCompacting: toComputed(holder.isCompacting),
        isHandingOff: toComputed(holder.isHandingOff),
        isSessionActive: toComputed(holder.isSessionActive),
        scrollToBottom: holder.scrollToBottom,
      })
      return () => h('div')
    },
  })
  return mount(Host)
}

describe('useMessageStreamScroll · 对话完成滚动 watch（fix-finish-scroll L2）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // MS1：isSessionActive true→false 触发一次 scrollToBottom('auto')（核心修复目标）。
  it('MS1: isSessionActive true→false（对话结束）→ scrollToBottom("auto") 被调用一次', async () => {
    const holder = makeDepsHolder({ isSessionActive: true })
    const wrapper = mountScroll(holder)
    await nextTick()
    // 清掉 onMounted 触发的初始 scrollToBottom('auto', true)，只观察 watch
    holder.scrollToBottom.mockClear()

    // 对话结束：true→false
    holder.isSessionActive.value = false
    await nextTick()

    expect(holder.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(holder.scrollToBottom).toHaveBeenCalledWith()
    wrapper.unmount()
  })

  // MS2：isSessionActive false→true（新对话开始）不触发（防误调）。
  // 理由：watch 条件是 `if (old && !nw)`——只在结束边沿触发，开始边沿不应滚。
  it('MS2: isSessionActive false→true（新对话开始）→ 不调用 scrollToBottom', async () => {
    const holder = makeDepsHolder({ isSessionActive: false })
    const wrapper = mountScroll(holder)
    await nextTick()
    holder.scrollToBottom.mockClear()

    // 新对话开始：false→true
    holder.isSessionActive.value = true
    await nextTick()

    expect(holder.scrollToBottom).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  // MS3：isSessionActive 恒 true（连续赋同值）不触发——watch 只在值变化时触发。
  it('MS3: isSessionActive 保持 true（无变化）→ 不调用 scrollToBottom', async () => {
    const holder = makeDepsHolder({ isSessionActive: true })
    const wrapper = mountScroll(holder)
    await nextTick()
    holder.scrollToBottom.mockClear()

    // 连续赋同值（ask-user respond 后仍在进行中，无完成边沿）
    holder.isSessionActive.value = true
    await nextTick()

    expect(holder.scrollToBottom).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('useMessageStreamScroll · 既有触发源回归（防 L2 改动破坏）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // MS4：挂载即滚到底（force=true，展示最新内容，不受 stickToBottom guard）。
  it('MS4: 挂载触发 scrollToBottom(true)（onMounted，force=true）', async () => {
    const holder = makeDepsHolder()
    const wrapper = mountScroll(holder)
    await nextTick()

    expect(holder.scrollToBottom).toHaveBeenCalledWith(true)
    wrapper.unmount()
  })

  // MS5：消息条数变化 → scrollToBottom()（既有触发源，L2 改动不应破坏）。
  it('MS5: currentMessages.length 变化 → scrollToBottom()（force 默认）', async () => {
    const holder = makeDepsHolder()
    const wrapper = mountScroll(holder)
    await nextTick()
    holder.scrollToBottom.mockClear()

    // 追加一条消息（length 变化）
    holder.currentMessages.value = [
      ...holder.currentMessages.value,
      { id: 'a2', role: 'assistant', content: 'second', status: 'complete', timestamp: Date.now() } as Message,
    ]
    await nextTick()

    expect(holder.scrollToBottom).toHaveBeenCalledWith()
    wrapper.unmount()
  })

  // MS6：完成滚动用 force=undefined（默认），尊重 stickToBottom guard（用户上滑时不强行拉回）。
  // 这与 MessageStream.vue 实际传参一致（不传 force → 默认 followIfStuck 走 guard）。
  it('MS6: 完成滚动的 scrollToBottom 不传 force（默认 undefined，尊重 guard）', async () => {
    const holder = makeDepsHolder({ isSessionActive: true })
    const wrapper = mountScroll(holder)
    await nextTick()
    holder.scrollToBottom.mockClear()

    holder.isSessionActive.value = false
    await nextTick()

    // 零参数（force 走默认值 undefined → followIfStuck 走 stickToBottom guard），不强制拉回上滑用户
    expect(holder.scrollToBottom).toHaveBeenCalledWith()
    expect(holder.scrollToBottom.mock.calls[0]).toHaveLength(0)
    wrapper.unmount()
  })
})
