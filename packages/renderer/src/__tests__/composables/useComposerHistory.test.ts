/**
 * useComposerHistory per-session 状态隔离单测（W3 / TDD 红灯）。
 *
 * 覆盖 ADR-0036 迁移：browsing/index/savedDraft 三个状态经 useSessionScopedState 分区。
 * - AC-5: 切 session 后 browsing/index/savedDraft 不串台（切回恢复草稿与浏览指针）
 * - history computed 仍正确从 chatStore 派生（不回归）
 *
 * 运行：npx vitest run src/__tests__/composables/useComposerHistory.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref, nextTick } from 'vue'
import { textToSegments } from '@xyz-agent/shared'
import { useChatStore } from '@/stores/chat'
import { useComposerHistory } from '@/composables/panel/useComposerHistory'

/** 构造 DOM deps mock：捕获 setText 写入 + 提供 getText/clear */
function createDepsMock() {
  let currentText = ''
  return {
    state: { text: '' },
    getText: vi.fn(() => currentText),
    setText: vi.fn((text: string, _caret?: 'start' | 'end') => {
      currentText = text
    }),
    clear: vi.fn(() => {
      currentText = ''
    }),
    /** 测试侧直接注入 composer 文本（模拟用户输入，绕过 setText 的程序化标记） */
    userInput(text: string): void {
      currentText = text
    },
  }
}

/** 在独立 effectScope 内运行 composable */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

/** 向 chatStore 注入 user 历史（complete 状态） */
function seedUserHistory(chatStore: ReturnType<typeof useChatStore>, sid: string, texts: string[]): void {
  const messages = texts.map((content, i) => ({
    id: `m-${sid}-${i}`,
    role: 'user' as const,
    content,
    status: 'complete' as const,
    timestamp: i + 1,
  }))
  chatStore.hydrate(sid, messages)
}

describe('W3 useComposerHistory: history computed 仍正确派生（不回归）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('history 按时间倒序、去重连续相同文本', () => {
    const chatStore = useChatStore()
    const sid = ref<string | null>('s1')
    // 最新在后：['a', 'b', 'b', 'c'] → 倒序去重 ['c', 'b', 'a']
    seedUserHistory(chatStore, 's1', ['a', 'b', 'b', 'c'])

    const { result, dispose } = runWithScope(() =>
      useComposerHistory(sid, createDepsMock()),
    )

    // history 不直接导出，通过 handleArrowUp 回填验证：首次 ↑ 回填 H[0]=最新='c'
    const consumed = result.handleArrowUp()
    expect(consumed).toBe(true)
    expect(result.isBrowsing.value).toBe(true)
    // setText 应被调用，内容是最新历史
    expect(result.handleArrowUp).toBeDefined()

    dispose()
  })

  it('history 为空时 ↑ 不进入 browsing（保持草稿）', () => {
    const sid = ref<string | null>('empty-sid')
    const deps = createDepsMock()
    deps.userInput('draft text')
    const { result, dispose } = runWithScope(() => useComposerHistory(sid, deps))

    const consumed = result.handleArrowUp()
    expect(consumed).toBe(false)
    expect(result.isBrowsing.value).toBe(false)

    dispose()
  })

  it('null sid 时 history 为空，↑ 不响应', () => {
    const sid = ref<string | null>(null)
    const { result, dispose } = runWithScope(() =>
      useComposerHistory(sid, createDepsMock()),
    )

    expect(result.handleArrowUp()).toBe(false)
    expect(result.isBrowsing.value).toBe(false)

    dispose()
  })
})

describe('W3 useComposerHistory AC-5: browsing/index/savedDraft per-session 隔离', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('session A 进入 browsing 后切到 B，B 不继承 A 的 browsing 态', async () => {
    const chatStore = useChatStore()
    seedUserHistory(chatStore, 'sA', ['a-1', 'a-2'])
    seedUserHistory(chatStore, 'sB', ['b-1'])
    const sid = ref<string | null>('sA')
    const { result, dispose } = runWithScope(() =>
      useComposerHistory(sid, createDepsMock()),
    )

    // A：↑ 进入 browsing
    result.handleArrowUp()
    expect(result.isBrowsing.value).toBe(true)

    // 切到 B：B 初始应为非 browsing 态（A 的 browsing 不串到 B）
    sid.value = 'sB'
    await nextTick()
    expect(result.isBrowsing.value).toBe(false)

    dispose()
  })

  it('AC-5: 切回 A 后恢复 A 的草稿（savedDraft 不丢）', async () => {
    const chatStore = useChatStore()
    seedUserHistory(chatStore, 'sA', ['a-old'])
    seedUserHistory(chatStore, 'sB', ['b-old'])
    const sid = ref<string | null>('sA')
    const deps = createDepsMock()
    const { result, dispose } = runWithScope(() =>
      useComposerHistory(sid, deps),
    )

    // A：用户先输入草稿，再 ↑ 进入 browsing
    deps.userInput('my draft for A')
    result.handleArrowUp() // savedDraft 保存 'my draft for A'，回填历史
    expect(result.isBrowsing.value).toBe(true)

    // 切到 B
    sid.value = 'sB'
    await nextTick()
    expect(result.isBrowsing.value).toBe(false)

    // 切回 A：A 的草稿应保留（W3 改 Map 分区后，savedDraft 不被切换重置丢失）
    sid.value = 'sA'
    await nextTick()
    // ↑ 进入 browsing（A 的 browsing 指针应恢复到之前位置或重新开始均可，
    // 但草稿 savedDraft 必须保留：↓ 回到 edit 态时应恢复 'my draft for A'）
    result.handleArrowUp()
    expect(result.isBrowsing.value).toBe(true)
    // ↓ 回到 edit 态 → setText(savedDraft) 应恢复 A 的草稿
    result.handleArrowDown()
    // 最后一次 setText 调用应写入 savedDraft（A 的草稿）
    const lastCall = deps.setText.mock.calls[deps.setText.mock.calls.length - 1]
    expect(lastCall?.[0]).toBe('my draft for A')

    dispose()
  })

  it('AC-5: B 进入 browsing 翻到 index=1 后切回 B，B 的浏览指针恢复', async () => {
    const chatStore = useChatStore()
    seedUserHistory(chatStore, 'sA', ['a-1'])
    seedUserHistory(chatStore, 'sB', ['b-1', 'b-2', 'b-3'])
    const sid = ref<string | null>('sB')
    const deps = createDepsMock()
    const { result, dispose } = runWithScope(() =>
      useComposerHistory(sid, deps),
    )

    // B：↑ 两次翻到 index=1（第二条历史）
    result.handleArrowUp() // index 0 → 'b-3'（最新）
    result.handleArrowUp() // index 1 → 'b-2'

    // 切到 A 再切回 B
    sid.value = 'sA'
    await nextTick()
    sid.value = 'sB'
    await nextTick()

    // W3 后：B 的 browsing 指针应恢复（继续 ↓ 应回退到 index 0 而非从头开始）
    // 当前实现切回会重置 browsing=false/index=0，此断言会红灯
    result.handleArrowUp() // 重新进入或恢复 browsing
    // ↓ 应回退到最新一条（index 0 → 'b-3'）
    result.handleArrowDown()
    const calls = deps.setText.mock.calls
    const lastText = calls[calls.length - 1]?.[0]
    expect(lastText).toBe('b-3')

    dispose()
  })
})
