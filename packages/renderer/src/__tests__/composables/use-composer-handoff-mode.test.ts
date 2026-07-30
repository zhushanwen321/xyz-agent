/**
 * useComposerHandoffMode 单元测试。
 *
 * 被测对象：composables/panel/useComposerHandoffMode.ts（从 Composer.vue 拆出的
 * handoff「交接」模式状态 + 行为 composable）。
 *
 * 覆盖全部公共 API：
 * - handoffMode / handoffModeRef（状态真源 + defineExpose 包装）
 * - enterHandoffMode / exitHandoffMode（互斥退出 fork + staging 进入/退出 + 聚焦）
 * - handleHandoffEsc（Esc 退出消费契约）
 * - handleHandoffSend（发送消费契约：成功/失败/staging 透传/空文本）
 * - handoffBoxClass / handoffPlaceholder（派生视图）
 * - 跨组件通道 useHandoffModeChannel（signal 命中本 session 才触发）
 *
 * 范式参照 use-composer-model-thinking.test.ts：直接 import composable（不 mount），
 * vi.mock 依赖，effectScope 包裹（watch 需 active scope 以便 stop 清理）。
 * useI18n 由 vitest-i18n-setup.ts 全局 mock（t() 按 zh-CN locale 解析），此处不重复 mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-composer-handoff-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock useToast：捕获 toastError（不真实推 toast 队列）──
const toastErrorMock = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    error: toastErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
    remove: vi.fn(),
  }),
}))

// ── mock useHandoffModeChannel：提供可控的 signal ref ──
// 真实模块是模块级单例 signal，跨测试会串扰；mock 后每个测试可重置 + 自由触发。
type HandoffEnterRequest = { id: number; srcSessionId: string }
const handoffSignal: Ref<HandoffEnterRequest | null> = ref(null)
vi.mock('@/composables/panel/useHandoffModeChannel', () => ({
  useHandoffModeChannel: () => ({ signal: handoffSignal }),
  triggerEnterHandoffMode: vi.fn(),
}))

import { useComposerHandoffMode } from '@/composables/panel/useComposerHandoffMode'

/** 构造注入的 deps（全部 spy），inputRef 默认 null，可按需注入 focus spy */
interface DepsSpies {
  inputRef: Ref<{ focus?: () => void } | null>
  setSending: ReturnType<typeof vi.fn>
  clearInput: ReturnType<typeof vi.fn>
  restoreInput: ReturnType<typeof vi.fn>
  exitForkMode: ReturnType<typeof vi.fn>
  handoff: ReturnType<typeof vi.fn>
  enterStagingMode: ReturnType<typeof vi.fn>
  exitStagingMode: ReturnType<typeof vi.fn>
  getStagingConfig: ReturnType<typeof vi.fn>
}

function makeDeps(): DepsSpies {
  const inputRef = ref<{ focus?: () => void } | null>(null)
  return {
    inputRef,
    setSending: vi.fn(),
    clearInput: vi.fn(),
    restoreInput: vi.fn(),
    exitForkMode: vi.fn(),
    handoff: vi.fn(() => Promise.resolve()),
    enterStagingMode: vi.fn(),
    exitStagingMode: vi.fn(),
    getStagingConfig: vi.fn(() => ({})),
  }
}

/** 包 effectScope 起一个被测实例；返回 scope 便于测试结束 stop（清 watch） */
function setup(sessionIdValue: string | null = 's1') {
  const sessionIdSource = ref<string | null>(sessionIdValue)
  const sessionId = computed(() => sessionIdSource.value)
  const deps = makeDeps()
  const scope = effectScope()
  const api = scope.run(() =>
    useComposerHandoffMode(
      sessionId,
      deps as unknown as Parameters<typeof useComposerHandoffMode>[1],
    ),
  )!
  return { sessionIdSource, sessionId, scope, deps, api }
}

beforeEach(() => {
  // useComposerHandoffMode 内部 useChatStore()（读 isHandingOff 驱动 StagingAction.isInProgress），
  // 需 active Pinia（参照 composer-fork-mode.test.ts / use-composer-*.test.ts 范式）。
  setActivePinia(createPinia())
  vi.clearAllMocks()
  handoffSignal.value = null
})

// ── enterHandoffMode ───────────────────────────────────────────────────────
describe('enterHandoffMode', () => {
  it('互斥退出 fork + 进入暂存态 + handoffMode 置 true', () => {
    const { deps, api } = setup()

    api.enterHandoffMode('src-1')

    expect(deps.exitForkMode).toHaveBeenCalledTimes(1)
    expect(deps.enterStagingMode).toHaveBeenCalledTimes(1)
    expect(api.handoffMode.value).toBe(true)
  })

  it('inputRef 有值时聚焦输入框', () => {
    const { deps, api } = setup()
    const focusSpy = vi.fn()
    deps.inputRef.value = { focus: focusSpy }

    api.enterHandoffMode('src-1')

    expect(focusSpy).toHaveBeenCalledTimes(1)
  })

  it('inputRef 为 null 时不抛错（可选链守卫）', () => {
    const { api } = setup()
    // inputRef.value 默认 null
    expect(() => api.enterHandoffMode('src-1')).not.toThrow()
    expect(api.handoffMode.value).toBe(true)
  })
})

// ── exitHandoffMode ────────────────────────────────────────────────────────
describe('exitHandoffMode', () => {
  it('handoffMode 置 false + 退出暂存态', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    expect(api.handoffMode.value).toBe(true)

    api.exitHandoffMode()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.exitStagingMode).toHaveBeenCalledTimes(1)
  })

  it('未进入 handoff 也可直接 exit（幂等）', () => {
    const { deps, api } = setup()
    api.exitHandoffMode()
    expect(api.handoffMode.value).toBe(false)
    expect(deps.exitStagingMode).toHaveBeenCalledTimes(1)
  })
})

// ── handoffModeRef（defineExpose 包装）──────────────────────────────────────
describe('handoffModeRef', () => {
  it('value 跟随 handoffMode ref（getter 代理）', () => {
    const { api } = setup()
    expect(api.handoffModeRef.value).toBe(false)

    api.enterHandoffMode('src-1')
    expect(api.handoffModeRef.value).toBe(true)

    api.exitHandoffMode()
    expect(api.handoffModeRef.value).toBe(false)
  })
})

// ── handoffBoxClass ─────────────────────────────────────────────────────────
describe('handoffBoxClass', () => {
  it('handoff 模式返回含 handoff-mode 的 accent class', () => {
    const { api } = setup()
    api.enterHandoffMode('src-1')

    expect(api.handoffBoxClass.value).toContain('handoff-mode')
  })

  it('非 handoff 模式返回空串', () => {
    const { api } = setup()
    expect(api.handoffBoxClass.value).toBe('')
  })
})

// ── handoffPlaceholder ──────────────────────────────────────────────────────
describe('handoffPlaceholder', () => {
  it('handoff 模式返回 i18n 文案', () => {
    const { api } = setup()
    api.enterHandoffMode('src-1')

    // t('panel.composer.handoffHint') 由 vitest-i18n-setup 解析 zh-CN locale
    expect(api.handoffPlaceholder.value).toBe(
      '输入内容将作为新 session 的首条消息发送给 AI（可选）…（⏎ 交接并发送，Esc 退出）',
    )
  })

  it('非 handoff 模式返回 null', () => {
    const { api } = setup()
    expect(api.handoffPlaceholder.value).toBeNull()
  })
})

// ── handleHandoffEsc ────────────────────────────────────────────────────────
describe('handleHandoffEsc', () => {
  function escEvent(): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  }

  it('非 handoff 模式返回 false（不消费）', () => {
    const { deps, api } = setup()
    const e = escEvent()
    expect(api.handleHandoffEsc(e)).toBe(false)
    // 不应 clearInput / 不应 exit
    expect(deps.clearInput).not.toHaveBeenCalled()
    expect(deps.exitStagingMode).not.toHaveBeenCalled()
  })

  it('handoff 模式但非 Escape 键返回 false（不消费）', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    const e = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })

    expect(api.handleHandoffEsc(e)).toBe(false)
    expect(deps.clearInput).not.toHaveBeenCalled()
    expect(api.handoffMode.value).toBe(true)
  })

  it('handoff + Escape：preventDefault + clearInput + 退出 + 返回 true', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    const preventDefault = vi.fn()
    const e = { key: 'Escape', preventDefault } as unknown as KeyboardEvent

    const consumed = api.handleHandoffEsc(e)

    expect(consumed).toBe(true)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(deps.clearInput).toHaveBeenCalledTimes(1)
    expect(api.handoffMode.value).toBe(false)
    // exit 走 exitHandoffMode → exitStagingMode
    expect(deps.exitStagingMode).toHaveBeenCalledTimes(1)
  })
})

// ── handleHandoffSend ───────────────────────────────────────────────────────
describe('handleHandoffSend', () => {
  it('非 handoff 模式返回 false（不消费，不走 handoff 流程）', async () => {
    const { deps, api } = setup()
    const consumed = await api.handleHandoffSend('hi')
    expect(consumed).toBe(false)
    expect(deps.handoff).not.toHaveBeenCalled()
    expect(deps.setSending).not.toHaveBeenCalled()
    expect(deps.clearInput).not.toHaveBeenCalled()
  })

  it('成功 + 非空文本：reply=text，clearInput + setSending(1→0) + 退出，返回 true', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')

    const consumed = await api.handleHandoffSend('hello world')

    expect(consumed).toBe(true)
    expect(deps.clearInput).toHaveBeenCalledTimes(1)
    // setSending 先 true 后 false
    expect(deps.setSending).toHaveBeenNthCalledWith(1, true)
    expect(deps.setSending).toHaveBeenNthCalledWith(2, false)
    expect(deps.setSending).toHaveBeenCalledTimes(2)
    // reply 透传 = trim 后的非空文本
    expect(deps.handoff).toHaveBeenCalledWith('src-1', 'hello world', {})
    // 成功后退出 handoff
    expect(api.handoffMode.value).toBe(false)
  })

  it('成功 + 空文本：reply=undefined（允许空发送），仍消费', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')

    const consumed = await api.handleHandoffSend('   ')

    expect(consumed).toBe(true)
    expect(deps.handoff).toHaveBeenCalledWith('src-1', undefined, {})
  })

  it('trim 文本：前后空白被裁掉再作 reply', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')

    await api.handleHandoffSend('  trimmed  ')

    expect(deps.handoff).toHaveBeenCalledWith('src-1', 'trimmed', {})
  })

  it('staging config 透传：getStagingConfig 返回值原样传给 handoff action', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    const staging = { modelOverride: 'p/m', thinkingOverride: 'high' }
    deps.getStagingConfig.mockReturnValue(staging)

    await api.handleHandoffSend('text')

    expect(deps.handoff).toHaveBeenCalledWith('src-1', 'text', staging)
  })

  it('失败（handoff action reject）：restoreInput + toastError + setSending(false) + 退出，返回 true', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    deps.handoff.mockRejectedValueOnce(new Error('boom'))

    const consumed = await api.handleHandoffSend('my draft')

    expect(consumed).toBe(true)
    // 失败 → 恢复草稿（原 text）
    expect(deps.restoreInput).toHaveBeenCalledWith('my draft')
    // toast 上报（i18n key 解析后含 error 文案）
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('交接失败：boom')
    // setSending 仍复位 false
    expect(deps.setSending).toHaveBeenLastCalledWith(false)
    // 失败也退出 handoff
    expect(api.handoffMode.value).toBe(false)
  })

  it('失败（非 Error 抛出值）：toast 文案兜底为 String(e)', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    deps.handoff.mockRejectedValueOnce('string error')

    await api.handleHandoffSend('draft')

    expect(toastErrorMock).toHaveBeenCalledWith('交接失败：string error')
  })

  it('失败分支也调了 clearInput + setSending(true)（发送流程一致前置）', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    deps.handoff.mockRejectedValueOnce(new Error('x'))

    await api.handleHandoffSend('draft')

    expect(deps.clearInput).toHaveBeenCalledTimes(1)
    expect(deps.setSending).toHaveBeenCalledWith(true)
  })
})

// ── 跨组件通道 useHandoffModeChannel ─────────────────────────────────────────
describe('跨组件通道：signal 命中本 session 才触发 enterHandoffMode', () => {
  it('signal 命中本 session（srcSessionId === sessionId.value）→ enterHandoffMode', async () => {
    const { deps, api } = setup('s1')

    handoffSignal.value = { id: 1, srcSessionId: 's1' }
    await nextTick()

    expect(api.handoffMode.value).toBe(true)
    expect(deps.exitForkMode).toHaveBeenCalledTimes(1)
    expect(deps.enterStagingMode).toHaveBeenCalledTimes(1)
  })

  it('signal 不命中本 session（srcSessionId !== sessionId.value）→ 不触发', async () => {
    const { deps, api } = setup('s1')

    handoffSignal.value = { id: 2, srcSessionId: 'other' }
    await nextTick()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.exitForkMode).not.toHaveBeenCalled()
    expect(deps.enterStagingMode).not.toHaveBeenCalled()
  })

  it('sessionId 为 null（landing 态）→ 即使 srcSessionId 非空也不触发', async () => {
    const { deps, api } = setup(null)

    handoffSignal.value = { id: 3, srcSessionId: 's1' }
    await nextTick()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.enterStagingMode).not.toHaveBeenCalled()
  })

  it('signal 为 null → 不触发', async () => {
    const { deps, api } = setup('s1')

    handoffSignal.value = null
    await nextTick()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.enterStagingMode).not.toHaveBeenCalled()
  })

  it('切换 sessionId 后，新 signal 按新 sessionId 判定命中', async () => {
    const { sessionIdSource, deps, api } = setup('s1')

    // 先发一个不命中的 signal（其他 session）
    handoffSignal.value = { id: 10, srcSessionId: 's2' }
    await nextTick()
    expect(api.handoffMode.value).toBe(false)

    // 切到 s2 后，针对 s2 的 signal 命中
    sessionIdSource.value = 's2'
    handoffSignal.value = { id: 11, srcSessionId: 's2' }
    await nextTick()

    expect(api.handoffMode.value).toBe(true)
    expect(deps.enterStagingMode).toHaveBeenCalledTimes(1)
  })
})
