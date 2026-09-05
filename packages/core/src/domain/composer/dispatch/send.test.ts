/**
 * useComposerSend 单元测试（D6 统一发送分发器，session-occupancy u5b）。
 *
 * 被测对象：domain/composer/dispatch/send.ts —— Composer onSend 统一分发入口
 * （Enter / Alt+Enter / 发送按钮共用）。
 * 职责：staging > [steer 路由] > canSend 守卫 > staging.send > [defer 路由] >
 * landing > bash > /compact > send + 失败 restoreSegments 回滚。
 *
 * [u5b 改造] isCompacting dep 退役 → getSendRoute（D6 路由：direct/steer/defer）；
 * 新增 steer dep（steer 路由终端）与 hasInput dep（steer 分支空输入守卫）。
 * 三/四/五用例由 isCompacting 判定改为 defer 路由驱动；新增 steer 路由分支行为用例
 * （行 2/3 语义：turn 活跃追加当前回合——优先级倒挂消除的核心断言）。
 *
 * 路由表六行的纯函数断言见 ./send-route.test.ts；本文件锁定分发器行为。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/send.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useComposerSend, type ComposerSendDeps } from './send'
import type { SendRoute } from './send-route'
import type { BashCommandExtract } from './bash'
import type { StagingAction, StagingConfig } from '../types'
import type { Segment } from '@xyz-agent/shared'

interface DepsControl {
  canSend: boolean
  hasInput: boolean
  sendRoute: SendRoute
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
  steer: ReturnType<typeof vi.fn>
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
    hasInput: true,
    sendRoute: 'direct',
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
    steer: vi.fn(async () => {}),
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
    hasInput: computed(() => ctrl.hasInput),
    getSendRoute: () => ctrl.sendRoute,
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
    steer: spies.steer,
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

  // ── [D6 u5b] steer 路由（行 2/3：turn 活跃 = dispatching/generating）──

  it('②d steer 路由（turn=generating + 本地 busy）→ steer(sid, segments) + clearInput，不走 canSend 拦截', async () => {
    // canSend=false（turn 活跃 → isActive → isBusy）：steer 判定先于 canSend 守卫——
    // 优先级倒挂消除的核心行为（turn 活跃时 Enter 语义 = 追加当前回合，不被 busy 锁拦死）。
    const { deps, spies } = setup({ canSend: false, sendRoute: 'steer' })
    await useComposerSend(deps).onSend()
    expect(spies.steer).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
    expect(spies.send).not.toHaveBeenCalled()
    expect(spies.compact).not.toHaveBeenCalled()
  })

  it('②e steer 路由（行 3：generating + compacting）→ 仍走 steer（turn 活跃优先于 compacting 维度）', async () => {
    // threshold turn 内压缩：D6 表行 3 steer（压缩后 turn 继续跑，steering 队列在压缩完成的
    // 下一次 LLM 调用前投递）——不误入 defer 队列。
    const { deps, spies } = setup({ canSend: false, sendRoute: 'steer', draft: '补充：别忘了加测试' })
    await useComposerSend(deps).onSend()
    expect(spies.steer).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.enqueueCompact).not.toHaveBeenCalled()
  })

  it('②f steer 路由（本地 busy）+ 空输入 → 拦截（不调 steer 不清输入）', async () => {
    const { deps, spies } = setup({ canSend: false, sendRoute: 'steer', hasInput: false })
    await useComposerSend(deps).onSend()
    expect(spies.steer).not.toHaveBeenCalled()
    expect(spies.clearInput).not.toHaveBeenCalled()
  })

  it('②g steer 路由（本地 busy）+ isSending=true（双发锁）→ 拦截', async () => {
    const { deps, spies } = setup({ canSend: false, sendRoute: 'steer' })
    ;(deps.isSending as unknown as { value: boolean }).value = true
    await useComposerSend(deps).onSend()
    expect(spies.steer).not.toHaveBeenCalled()
    expect(spies.clearInput).not.toHaveBeenCalled()
  })

  it('②i 投影失配窗口（route=steer + 本地 idle）→ 落 direct 流程（send 兜底，不丢输入）', async () => {
    // 续跑 turn-start 先于 message_start 的毫秒级窗口：本地已收口（canSend=true）而投影
    // 已 flip steer——不进 steer 分支（steer 内部 isActive 守卫会静默吞输入），落 direct
    // 由 useChat.send B 策略/拒绝兜底自愈。分发器层断言：不丢输入、不误入 defer 队列。
    const { deps, spies } = setup({ canSend: true, sendRoute: 'steer', draft: '失配窗口消息' })
    await useComposerSend(deps).onSend()
    expect(spies.send).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.steer).not.toHaveBeenCalled()
    expect(spies.enqueueCompact).not.toHaveBeenCalled()
  })

  it('②h staging 活跃 + steer 路由 → staging 优先于路由（staging 提交与 occupancy 路由正交）', async () => {
    const { deps, spies } = setup({ sendRoute: 'steer', hasActiveStaging: true, stagingSendReturn: true })
    await useComposerSend(deps).onSend()
    expect(spies.stagingSend).toHaveBeenCalledWith('hello', {})
    expect(spies.steer).not.toHaveBeenCalled()
  })

  // ── [D6 u5b] defer 路由（行 4/5/6：settling / compacting / bash）──

  it('③ defer 路由 + `/` 前缀命令 → toastError 拒绝，不入队（命令无法延迟重放）', async () => {
    const { deps, spies } = setup({ sendRoute: 'defer', draft: '/compact later' })
    await useComposerSend(deps).onSend()
    expect(spies.toastError).toHaveBeenCalledWith('panel.composer.commandQueuedRejected')
    expect(spies.enqueueCompact).not.toHaveBeenCalled()
    expect(spies.clearInput).not.toHaveBeenCalled()
  })

  it('④ defer 路由 + `!` 前缀命令 → toastError 拒绝，不入队', async () => {
    const { deps, spies } = setup({ sendRoute: 'defer', draft: '!ls' })
    await useComposerSend(deps).onSend()
    expect(spies.toastError).toHaveBeenCalledWith('panel.composer.commandQueuedRejected')
    expect(spies.enqueueCompact).not.toHaveBeenCalled()
  })

  it('⑤ defer 路由（settling / bash 忙）+ 普通文本 → enqueueCompact + clearInput', async () => {
    // defer 泛化：settling（行 4）与 bash（行 6）与 compacting（行 5）同走入队——
    // 路由值由 sessionPhase 派生，分发器不区分忙的来源维度。
    const { deps, spies } = setup({ sendRoute: 'defer', draft: 'queued msg' })
    await useComposerSend(deps).onSend()
    expect(spies.enqueueCompact).toHaveBeenCalledWith('s1', 'queued msg')
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('⑤b defer 路由 + landing（无 session）→ 不入队（sessionIdRef null 防御守卫）', async () => {
    const { deps, spies } = setup({ sendRoute: 'defer', variant: 'landing', sessionId: null })
    await useComposerSend(deps).onSend()
    expect(spies.enqueueCompact).not.toHaveBeenCalled()
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

  it('⑧ direct + trySendBash 命中 → return，普通 send 不调', async () => {
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
