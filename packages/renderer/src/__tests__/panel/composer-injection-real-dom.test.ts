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

// ── W18: split / dual panel 多 Composer 实例守护测试 ─────────────────────────────
// 防的 bug：split（panel+landing 同时挂载）/ dual panel 场景下，target=current 且
// sessionId 匹配活跃 session 时，可能被多个 Composer 实例误消费（双重注入）。
// 锁定契约：variant=panel 按 sessionId 精确匹配，variant=landing 仅消费 sessionId=null 的请求。
describe('W18: split / dual panel 多 Composer 实例注入隔离', () => {
  /**
   * 双挂载 setup：panel + landing 两个 Composer 共享同一 composerInjectionStore
   * 与同一 contenteditable 池（用不同 el 模拟两个独立 Composer 实例）。
   */
  function setupDualMount(panelSessionId: string | null) {
    const panelChain = setupRealChipChain('panel', panelSessionId)
    const landingChain = setupRealChipChain('landing', null)
    // 共享同一 store（pinia 单例，第二次 setupRealChipChain 复用同一 store 实例）
    return {
      panelEl: panelChain.el,
      landingEl: landingChain.el,
      store: panelChain.store,
    }
  }

  it('W18-1: panel + landing 双挂载 + target=current + sessionId=活跃 session → 仅 panel 注入，landing 不误消费', async () => {
    // 场景：split 视图（panel 显示活跃 session 的对话流，landing 显示空起始页）。
    // 用户从 drawer 注入到「当前活跃 session」。
    // 期望：panel composer（variant=panel，sessionId 匹配活跃 session）消费；
    //      landing composer（variant=landing，sessionId=null 不匹配 current 的非 null sessionId）不消费。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'current', path: 'main.ts', sessionId: 's-active' })
    await nextTick()

    // panel 注入成功
    const panelChip = panelEl.querySelector('.mention-file') as HTMLElement
    expect(panelChip).toBeTruthy()
    expect(panelChip.dataset.chipPath).toBe('main.ts')

    // landing 未注入（variant=landing 只消费 sessionId=null 的请求）
    expect(landingEl.querySelector('.mention-file')).toBeNull()

    // pendingInjection 被消费后清空（一次注入只对应一个 Composer，无双重消费）
    expect(store.pendingInjection).toBeNull()
  })

  it('W18-2: panel + landing 双挂载 + target=current + sessionId=null（routeToLanding 改写后）→ 仅 landing 注入', async () => {
    // 场景：阶段二，routeToLanding 把 target=new 改为 current 且 sessionId=null。
    // 此时 panel composer 不匹配（sessionId=null ≠ panel 的活跃 session），landing 匹配。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'current', path: 'new-task.ts', sessionId: null })
    await nextTick()

    // landing 注入成功（variant=landing 消费 sessionId=null 的 current 请求）
    const landingChip = landingEl.querySelector('.mention-file') as HTMLElement
    expect(landingChip).toBeTruthy()
    expect(landingChip.dataset.chipPath).toBe('new-task.ts')

    // panel 不匹配（sessionId=null ≠ 's-active'）
    expect(panelEl.querySelector('.mention-file')).toBeNull()
    expect(store.pendingInjection).toBeNull()
  })

  it('W18-3: panel + landing 双挂载 + target=new → landing 直接消费（阶段一前置：landing 已挂载）', async () => {
    // 场景：用户停在 landing 态，从 drawer 发起新对话注入。
    // 期望：landing composer 已挂载时直接消费 target=new（不路由到自身），
    //      panel composer 不消费 target=new（仅 session composer 触发 startFlow，但此处 panel 不匹配）。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'new', path: 'fresh.ts', sessionId: 's-active' })
    await nextTick()

    // landing 直接消费 target=new
    const landingChip = landingEl.querySelector('.mention-file') as HTMLElement
    expect(landingChip).toBeTruthy()
    expect(landingChip.dataset.chipPath).toBe('fresh.ts')

    // panel 不注入（target=new 仅 landing composer 或路由阶段二消费）
    expect(panelEl.querySelector('.mention-file')).toBeNull()
    expect(store.pendingInjection).toBeNull()
  })

  it('W18-4: 双 Composer 注入 chip 数量守恒（无双重注入）', async () => {
    // 防止 split 模式下 watch 在两个 Composer 实例都触发导致同一请求注入两次（chip 翻倍）。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'current', path: 'once.ts', sessionId: 's-active' })
    await nextTick()

    // 两个 Composer 实例合计只产生 1 个 chip（panel 消费，landing 不消费）
    const totalChips =
      panelEl.querySelectorAll('.mention-file').length +
      landingEl.querySelectorAll('.mention-file').length
    expect(totalChips).toBe(1)
  })
})
