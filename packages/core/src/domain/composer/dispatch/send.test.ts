/**
 * useComposerSend 单元测试。
 *
 * 被测对象：domain/composer/dispatch/send.ts —— Composer onSend 发送分流。
 * 职责：6 优先级分流（staging 守卫 > staging.send > isCompacting > landing > bash > /compact > send）
 * + 失败 restoreSegments 回滚。
 *
 * 策略：全 deps mock。control 对象驱动只读 ComputedRef（canSend/isCompacting/...），
 * spies 记录调用。isSending 用真 ref（onSend 会写）。composerBash 的 extractBashCommand /
 * trySendBash 用 vi.fn 返回 ctrl 控制的值。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/send.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useComposerSend, type ComposerSendDeps } from './send'
import type { BashCommandExtract } from './bash'
import type { StagingAction, StagingConfig } from '../types'
import type { Segment } from '@xyz-agent/shared'

interface DepsControl {
  canSend: boolean
  isCompacting: boolean
  hasActiveStaging: boolean
  activeStagingAllowsEmpty: boolean
  variant: 'panel' | 'landing'
  draft: string
  sessionId: string | null
  stagingSendReturn: boolean
  bashTryReturn: boolean
  bashExtract: BashCommandExtract
  localThinkingLevel: string | undefined
}

interface Spies {
  stagingSend: ReturnType<typeof vi.fn<(text: string, staging: StagingConfig) => Promise<boolean>>>
  getStagingConfig: ReturnType<typeof vi.fn>
  clearInput: ReturnType<typeof vi.fn>
  restoreSegments: ReturnType<typeof vi.fn>
  submitFirstMessage: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  compact: ReturnType<typeof vi.fn>
  enqueueCompact: ReturnType<typeof vi.fn>
  toastError: ReturnType<typeof vi.fn>
  trySendBash: ReturnType<typeof vi.fn>
  extractBashCommand: ReturnType<typeof vi.fn>
  getSegments: ReturnType<typeof vi.fn>
}

const SEGMENTS: Segment[] = [{ type: 'text', text: 'hello' }] as unknown as Segment[]

function setup(initial?: Partial<DepsControl>): { deps: ComposerSendDeps; spies: Spies; ctrl: DepsControl } {
  const ctrl: DepsControl = {
    canSend: true,
    isCompacting: false,
    hasActiveStaging: false,
    activeStagingAllowsEmpty: false,
    variant: 'panel',
    draft: 'hello',
    sessionId: 's1',
    stagingSendReturn: false,
    bashTryReturn: false,
    bashExtract: { type: 'not-bash' },
    localThinkingLevel: undefined,
    ...initial,
  }
  const spies: Spies = {
    stagingSend: vi.fn(async () => ctrl.stagingSendReturn),
    getStagingConfig: vi.fn(() => ({})),
    clearInput: vi.fn(),
    restoreSegments: vi.fn(),
    submitFirstMessage: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    enqueueCompact: vi.fn(),
    toastError: vi.fn(),
    trySendBash: vi.fn(async () => ctrl.bashTryReturn),
    extractBashCommand: vi.fn(() => ctrl.bashExtract),
    getSegments: vi.fn(() => SEGMENTS),
  }
  const isSending = ref(false)
  const deps: ComposerSendDeps = {
    staging: {
      hasActiveStaging: computed(() => ctrl.hasActiveStaging),
      send: spies.stagingSend,
      activeStaging: computed(() =>
        ctrl.hasActiveStaging
          ? ({ allowsEmptySend: ctrl.activeStagingAllowsEmpty } as unknown as StagingAction)
          : null,
      ),
    },
    getStagingConfig: spies.getStagingConfig,
    canSend: computed(() => ctrl.canSend),
    isCompacting: computed(() => ctrl.isCompacting),
    draft: computed(() => ctrl.draft),
    inputRef: computed(() => ({ getSegments: spies.getSegments })),
    sessionIdRef: computed(() => ctrl.sessionId),
    variantRef: computed(() => ctrl.variant),
    composerBash: {
      extractBashCommand: spies.extractBashCommand,
      trySendBash: spies.trySendBash,
    },
    clearInput: spies.clearInput,
    restoreSegments: spies.restoreSegments,
    isSending,
    flow: { submitFirstMessage: spies.submitFirstMessage },
    localThinkingLevel: ref(ctrl.localThinkingLevel),
    send: spies.send,
    compact: spies.compact,
    enqueueCompact: spies.enqueueCompact,
    toastError: spies.toastError,
    t: ((k: string) => k) as ComposerSendDeps['t'],
  }
  return { deps, spies, ctrl }
}

describe('useComposerSend.onSend', () => {
  it('① staging 守卫拦截：canSend=false + 非 staging 活跃 → return，不调任何发送', async () => {
    const { deps, spies } = setup({ canSend: false, hasActiveStaging: false })
    await useComposerSend(deps).onSend()
    expect(spies.stagingSend).not.toHaveBeenCalled()
    expect(spies.send).not.toHaveBeenCalled()
    expect(spies.compact).not.toHaveBeenCalled()
  })

  it('② staging.hasActiveStaging + send 返回 true → 消费 staging，不走普通 send', async () => {
    const { deps, spies } = setup({ hasActiveStaging: true, stagingSendReturn: true })
    await useComposerSend(deps).onSend()
    expect(spies.stagingSend).toHaveBeenCalledWith('hello', {})
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('②b staging 活跃 + isSending=true（双发锁）→ 拦截，不调 staging.send', async () => {
    // isSending 是 staging 发送唯一忙锁：fork/handoff 发送自身置位期间禁止重入。
    // 真实链路 isSending=true → canSend 必为 false（canSend=hasInput∧¬isBusy），mock 同组合。
    const { deps, spies } = setup({ canSend: false, hasActiveStaging: true, stagingSendReturn: true })
    ;(deps.isSending as unknown as { value: boolean }).value = true
    await useComposerSend(deps).onSend()
    expect(spies.stagingSend).not.toHaveBeenCalled()
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('②c staging 活跃 + canSend=false + allowsEmptySend=false → 拦截（fork 空文本不允许）', async () => {
    const { deps, spies } = setup({ canSend: false, hasActiveStaging: true, activeStagingAllowsEmpty: false })
    await useComposerSend(deps).onSend()
    expect(spies.stagingSend).not.toHaveBeenCalled()
  })

  it('③ isCompacting + `/` 前缀命令 → toastError 拒绝，不入队', async () => {
    const { deps, spies } = setup({ isCompacting: true, draft: '/compact later' })
    await useComposerSend(deps).onSend()
    expect(spies.toastError).toHaveBeenCalledWith('panel.composer.commandQueuedRejected')
    expect(spies.enqueueCompact).not.toHaveBeenCalled()
    expect(spies.clearInput).not.toHaveBeenCalled()
  })

  it('④ isCompacting + `!` 前缀命令 → toastError 拒绝，不入队', async () => {
    const { deps, spies } = setup({ isCompacting: true, draft: '!ls' })
    await useComposerSend(deps).onSend()
    expect(spies.toastError).toHaveBeenCalledWith('panel.composer.commandQueuedRejected')
    expect(spies.enqueueCompact).not.toHaveBeenCalled()
  })

  it('⑤ isCompacting + 普通文本 → enqueueCompact + clearInput', async () => {
    const { deps, spies } = setup({ isCompacting: true, draft: 'queued msg' })
    await useComposerSend(deps).onSend()
    expect(spies.enqueueCompact).toHaveBeenCalledWith('s1', 'queued msg')
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
  })

  it('⑥ landing + bash empty → return，不提交', async () => {
    const { deps, spies } = setup({ variant: 'landing', bashExtract: { type: 'empty' } })
    await useComposerSend(deps).onSend()
    expect(spies.submitFirstMessage).not.toHaveBeenCalled()
    expect(spies.clearInput).not.toHaveBeenCalled()
  })

  it('⑦ landing + 普通首发 → submitFirstMessage(segments, thinkingLevel, undefined)', async () => {
    const { deps, spies } = setup({
      variant: 'landing',
      localThinkingLevel: 'high',
      bashExtract: { type: 'not-bash' },
    })
    await useComposerSend(deps).onSend()
    expect(spies.submitFirstMessage).toHaveBeenCalledWith(SEGMENTS, 'high', undefined)
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
  })

  it('⑦b landing + bash command → submitFirstMessage 传 bashExtract（结构含 command/exclude）', async () => {
    // 源码：bashCommand = bashExtract.type === 'command' ? bashExtract : undefined
    // 直接传整个 bashExtract 对象（含 type 字段，结构上满足 {command, excludeFromContext} 契约）
    const bashExtract: BashCommandExtract = { type: 'command', command: 'ls', excludeFromContext: false }
    const { deps, spies } = setup({ variant: 'landing', bashExtract })
    await useComposerSend(deps).onSend()
    expect(spies.submitFirstMessage).toHaveBeenCalledWith(SEGMENTS, undefined, bashExtract)
  })

  it('⑧ active + trySendBash 命中 → return，普通 send 不调', async () => {
    const { deps, spies } = setup({ variant: 'panel', bashTryReturn: true, draft: '!ls' })
    await useComposerSend(deps).onSend()
    expect(spies.trySendBash).toHaveBeenCalledWith('!ls')
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('⑨ `/compact` 命令 → compact(sessionId, undefined)', async () => {
    const { deps, spies } = setup({ variant: 'panel', draft: '/compact' })
    await useComposerSend(deps).onSend()
    expect(spies.compact).toHaveBeenCalledWith('s1', undefined)
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('⑨b `/compact x` 带参数 → compact 传 customInstructions', async () => {
    const { deps, spies } = setup({ variant: 'panel', draft: '/compact focus on auth' })
    await useComposerSend(deps).onSend()
    expect(spies.compact).toHaveBeenCalledWith('s1', 'focus on auth')
  })

  it('⑩ 普通发送 → send(sessionId, segments)', async () => {
    const { deps, spies } = setup({ variant: 'panel', draft: 'hello' })
    await useComposerSend(deps).onSend()
    expect(spies.send).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.compact).not.toHaveBeenCalled()
  })

  it('⑪ 普通发送失败 → restoreSegments + toastError 回滚', async () => {
    const { deps, spies } = setup({ variant: 'panel', draft: 'hello' })
    spies.send.mockRejectedValueOnce(new Error('boom'))
    await useComposerSend(deps).onSend()
    expect(spies.restoreSegments).toHaveBeenCalledWith(SEGMENTS)
    expect(spies.toastError).toHaveBeenCalledWith('panel.panel.sendFailed')
  })

  it('⑫ landing 首发失败 → restoreSegments + toastError', async () => {
    const { deps, spies } = setup({ variant: 'landing' })
    spies.submitFirstMessage.mockRejectedValueOnce(new Error('landing fail'))
    await useComposerSend(deps).onSend()
    expect(spies.restoreSegments).toHaveBeenCalledWith(SEGMENTS)
    expect(spies.toastError).toHaveBeenCalledWith('panel.panel.taskFailed')
  })
})
