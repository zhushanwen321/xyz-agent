/**
 * composer 注入真实 DOM chip 端到端测试（R1/R3 补充验证）。
 *
 * W2 的 composer-file-injection.test.ts 用 mock ComposerInput（spy 验证调用）。
 * 本测试验证「真实 DOM chip 出现」：mount 真实 ComposerInput 子树成本太高（需 stub
 * CommandPopover/AddMenu/ModelSelect 等重依赖），改用直接组合 useComposerInjection +
 * 真实 useComposerChipCommands，验证 watch 触发后 contenteditable 内真实 .mention-file chip。
 *
 * 覆盖：
 * - R1: store 写入 target=current → useComposerInjection watch → 真实 insertFileChip
 *   → contenteditable 内出现 .mention-file chip（dataset.chipPath 正确）
 * - R3: target=new → landing composer 消费 → 真实 DOM chip
 *
 * 这验证了 store→watch→chip 的完整链路（非 spy 调用断言，而是真实 DOM 节点）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useComposerInjection } from '@/composables/panel/useComposerInjection'
import { useComposerInjectionStore } from '@/stores/composer-injection'
import { useComposerChipCommands } from '@/composables/useComposerChipCommands'
import type ComposerInput from '@/components/panel/ComposerInput.vue'

// mock useNewTaskFlow（target=new 路由用，避免真实 startFlow 副作用）
vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    startFlow: vi.fn(),
    state: ref('idle'),
    currentSessionId: ref(null),
  }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

/**
 * 搭建真实 chip 操作链路：contenteditable div + useComposerChipCommands（真实 DOM）+
 * 一个模拟 ComposerInput 的 expose 对象（含真实 insertFileChip）。
 * useComposerInjection 通过 inputRef.value.insertFileChip 调用，与真实 ComposerInput 行为一致。
 */
function setupRealChipChain(variant: 'panel' | 'landing', sessionId: string | null) {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  el.setAttribute('data-testid', 'composer-input')
  document.body.appendChild(el)
  // 清掉前一个测试残留的 selection range（指向已移除节点会导致 insertNode 静默失败）
  window.getSelection()?.removeAllRanges()
  const elRef = ref(el) as Ref<HTMLDivElement | null>
  const chipCommands = useComposerChipCommands(elRef, {
    onChanged: vi.fn(),
    restoreSelection: vi.fn(),
  })
  // 模拟 ComposerInput 的 defineExpose 对象（useComposerInjection 通过 inputRef.value 访问）
  const fakeInputRef = ref({
    focus: vi.fn(),
    insertFileChip: chipCommands.insertFileChip,
  } as unknown as InstanceType<typeof ComposerInput>)
  const sessionIdRef = ref(sessionId)
  const variantRef = ref(variant)
  useComposerInjection(fakeInputRef, sessionIdRef, variantRef)
  return { el, store: useComposerInjectionStore() }
}

describe('composer 注入真实 DOM chip（R1/R3）', () => {
  it('R1: target=current → watch → contenteditable 内真实 .mention-file chip', async () => {
    const { el, store } = setupRealChipChain('panel', 's1')
    store.requestInjection({ target: 'current', path: 'src/foo.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipType).toBe('file')
    expect(chip.dataset.chipPath).toBe('src/foo.ts')
    expect(chip.querySelector('.chip-label')).toBeTruthy()
  })

  it('R1b: target=current 带 lineRange → 真实 chip dataset 含行范围', async () => {
    const { el, store } = setupRealChipChain('panel', 's1')
    store.requestInjection({
      target: 'current',
      path: 'src/foo.ts',
      lineStart: 10,
      lineEnd: 20,
      sessionId: 's1',
    })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip.dataset.chipLineStart).toBe('10')
    expect(chip.dataset.chipLineEnd).toBe('20')
  })

  it('R3: target=new → landing composer 消费 → 真实 DOM chip', async () => {
    const { el, store } = setupRealChipChain('landing', null)
    store.requestInjection({ target: 'new', path: 'bar.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipPath).toBe('bar.ts')
  })

  it('R1c: 注入后 pendingInjection 清空（消费即清）', async () => {
    const { store } = setupRealChipChain('panel', 's1')
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    await nextTick()
    expect(store.pendingInjection).toBeNull()
  })
})
