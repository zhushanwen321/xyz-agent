/**
 * useComposerForkMode —— Composer 的 fork 提问模式（FR-13/14/15）。
 *
 * 从 Composer.vue 拆出（script setup 行数合规）。职责：
 * - forkMode 状态真源：是否处于「从某条 assistant fork 出新分支」的提问模式
 * - forkSource：记录 fork 来源（srcSessionId = fork 点所在 session，fromMessageId = fork 点 assistant id）
 * - enterForkMode / exitForkMode：进入（记来源 + 聚焦输入框）/ 退出（复位状态）
 * - 跨组件触发通道：watch useForkModeChannel 的 signal（Sidebar ⌘⇧G 请求），命中本 session 时 enterForkMode
 * - forkBoxClass / forkPlaceholder：fork 模式派生的 class 与 placeholder 文案
 * - handleForkEsc：Esc 退出（清空输入 + exitForkMode），返回是否已消费
 * - handleForkSend：fork 模式发送（调 forkSessionAsk + 退出），返回是否已消费
 * - forkModeRef：{ value: boolean } 包装对象，给 defineExpose 用（避免 Vue 解包顶层 ref 导致 vm.forkMode 变 boolean）
 *
 * 发送/清空输入等副作用通过 deps 注入（Composer 持有 draft/isSending/clearInput/restoreInput 真源），
 * 保持 fork 状态真源单一且不侵入 Composer 已稳定的发送/草稿流程。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitFork } from '@lucide/vue'
import { useSidebar } from '@/composables/features/useSidebar'
import { useToast } from '@/composables/useToast'
import { useForkModeChannel } from '@/composables/panel/useForkModeChannel'
import type { StagingAction } from '@/composables/panel/staging-types'
import type ComposerInput from '@/components/panel/ComposerInput.vue'

/** fork 发送副作用依赖（由 Composer 注入，避免重复持有 draft/isSending 真源） */
interface ForkDeps {
  /** ComposerInput 实例 ref：enterForkMode 聚焦输入框用 */
  inputRef: Ref<InstanceType<typeof ComposerInput> | null>
  /** 发送中标志位 setter（fork 发送期间置 true，结束复位） */
  setSending: (value: boolean) => void
  /** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
  clearInput: () => void
  /** 发送失败时恢复草稿到输入区 */
  restoreInput: (text: string) => void
  /** Staging Mode（ADR-0043）：进入暂存态（快照模型/thinking） */
  enterStagingMode: () => void
  /** Staging Mode：退出暂存态（清空快照，恢复常规态） */
  exitStagingMode: () => void
  /** Staging Mode：获取暂存配置（供 fork 发送时透传给新 session） */
  getStagingConfig: () => { modelOverride?: string; thinkingOverride?: string }
}

/**
 * @param sessionId 当前 session id（null = landing 态，signal 守卫用）
 * @param deps 发送副作用依赖
 */
export function useComposerForkMode(
  sessionId: ComputedRef<string | null>,
  deps: ForkDeps,
): {
  forkMode: Ref<boolean>
  /** { value: boolean } 包装对象，给 defineExpose 用（不被 Vue 解包，对齐 vm.forkMode.value 访问契约） */
  forkModeRef: { readonly value: boolean }
  enterForkMode: (srcSessionId: string, fromMessageId: string) => void
  exitForkMode: () => void
  /** fork 模式 composer-box class（accent 边 + 3px ring glow + accent 底）；非 fork 模式返回空串 */
  forkBoxClass: ComputedRef<string>
  /** fork 模式 placeholder 文案；非 fork 模式返回 null（调用方回退到普通 placeholder） */
  forkPlaceholder: ComputedRef<string | null>
  /** Esc 处理：fork 模式下清空输入 + 退出，返回 true 表示已消费；否则返回 false */
  handleForkEsc: (e: KeyboardEvent) => boolean
  /** fork 模式发送：调 forkSessionAsk + exitForkMode，返回 true 表示已消费；否则返回 false */
  handleForkSend: (text: string) => Promise<boolean>
  /**
   * 包装成 StagingAction（fork 实现），供 useComposerStaging 注册消费。
   * 不改变现有 forkMode/enterForkMode 等 expose 契约（仅追加 adapter，对齐 ADR-0044）。
   */
  asStagingAction: () => StagingAction
} {
  const { t } = useI18n()
  const { error: toastError } = useToast()
  // forkSessionAsk 在 useSidebar 内编排 fork+send+失败回滚（ADR：features 层）。
  const { forkSessionAsk } = useSidebar()

  /** fork 提问模式开关：true 时 composer 顶部显 mode-chip + 三重视觉，发送走 forkSessionAsk */
  const forkMode = ref(false)
  /** fork 来源：srcSessionId（fork 点 session）+ fromMessageId（fork 点 assistant id） */
  const forkSource = ref<{ srcSessionId: string; fromMessageId: string } | null>(null)

  function enterForkMode(srcSessionId: string, fromMessageId: string): void {
    // Staging Mode（ADR-0043）：快照当前模型/thinking，进入暂存态
    deps.enterStagingMode()
    forkSource.value = { srcSessionId, fromMessageId }
    forkMode.value = true
    // 聚焦输入框，让用户立即键入 fork 提问内容
    deps.inputRef.value?.focus?.()
  }

  function exitForkMode(): void {
    forkMode.value = false
    forkSource.value = null
    // Staging Mode：退出暂存态，chip 恢复读源 session 模型
    deps.exitStagingMode()
  }

  // 跨组件触发通道：Sidebar 全局快捷键（⌘⇧G → enterForkModeFromLastAssistant）经 signal
  // 请求 Composer 进 fork 模式。Composer 仍是 forkMode 状态真源（发送/Esc/切 session 强耦合）。
  const { signal: forkEnterSignal } = useForkModeChannel()
  watch(forkEnterSignal, (req) => {
    if (!req) return
    // signal 只对当前 panel composer 生效：srcSessionId 必须是本 composer 的 session，
    // 避免双 panel 下快捷键误触发非焦点 panel 的 composer。
    if (req.srcSessionId !== sessionId.value) return
    enterForkMode(req.srcSessionId, req.fromMessageId)
  })

  /** fork 模式三重视觉 class（accent 边 + 3px ring glow + accent 底）；非 fork 模式返回空串 */
  const forkBoxClass = computed(() =>
    forkMode.value
      ? 'fork-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.45))] bg-[var(--accent-soft)]'
      : '',
  )

  /** fork 模式 placeholder 文案；非 fork 模式返回 null（调用方回退到普通 placeholder） */
  const forkPlaceholder = computed(() => (forkMode.value ? t('panel.composer.forkHint') : null))

  /**
   * Esc 处理：fork 模式下清空输入 + 退出。
   * @returns true 表示已消费（composer 聚焦时优先于全局 Esc handler）
   */
  function handleForkEsc(e: KeyboardEvent): boolean {
    if (!forkMode.value || e.key !== 'Escape') return false
    e.preventDefault()
    deps.clearInput()
    exitForkMode()
    return true
  }

  /**
   * fork 模式发送：调 forkSessionAsk（fork 新分支 + content 作首条 user），
   * 发送成功或失败后退出 fork 模式回普通态。
   * @param text 当前 draft（作 fork 分支首条 user content）
   * @returns true 表示已消费（onSend 开头短路，不走普通 send 流程）；非 fork 模式返回 false
   */
  async function handleForkSend(text: string): Promise<boolean> {
    if (!forkMode.value || !forkSource.value) return false
    const { srcSessionId, fromMessageId } = forkSource.value
    deps.clearInput()
    deps.setSending(true)
    try {
      // Staging Mode（ADR-0043）：透传暂存的模型/thinking 配置给新 session
      const staging = deps.getStagingConfig()
      await forkSessionAsk(srcSessionId, fromMessageId, text, staging)
    } catch (e) {
      deps.restoreInput(text)
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('panel.panel.sendFailed', { error: msg }))
    } finally {
      deps.setSending(false)
      exitForkMode()
    }
    return true
  }

  /**
   * { value: boolean } 包装对象（非 ref，不被 defineExpose 解包），其 value 经 getter
   * 代理到响应式 forkMode ref，既保留响应式又对齐 vm.forkMode.value 访问契约。
   */
  const forkModeRef = {
    get value(): boolean {
      return forkMode.value
    },
  }

  /**
   * 包装成 StagingAction（fork 实现，ADR-0044）。
   *
   * adapter 层：把 forkMode/enterForkMode/exitForkMode/handleForkSend/handleForkEsc/
   * forkBoxClass/forkPlaceholder 收敛为单一策略对象，供 useComposerStaging 聚合路由。
   * 不改变底层 ref/方法，仅追加 wrapper，保持 expose 契约 + 测试兼容。
   */
  function asStagingAction(): StagingAction {
    return {
      type: 'fork',
      isActive: computed(() => forkMode.value),
      enter: (source) => {
        // source 实际是 ForkSource（含 fromMessageId），由 useComposerStaging.enter('fork', source) 调用方保证；
        // StagingAction.enter 默认泛型为 StagingSource（联合类型），这里收窄取 fromMessageId。
        const forkSource = source as { srcSessionId: string; fromMessageId: string }
        enterForkMode(forkSource.srcSessionId, forkSource.fromMessageId)
      },
      exit: () => exitForkMode(),
      /**
       * send 直接调 handleForkSend(text)，忽略传入的 staging 参数。
       * 原因：handleForkSend 内部已调 deps.getStagingConfig() 取模型/thinking 快照配置，
       * 其数据源与 useComposerModelThinking.getStagingConfig 相同，外部传参与内部自取等价，
       * 故不复用 staging 参数（避免 fork/handoff 在 useComposerStaging.send 处重复透传）。
       */
      send: async (text) => { await handleForkSend(text) },
      allowsEmptySend: false,
      handleEsc: handleForkEsc,
      // fork-ask 是前端编排的 fork+send，无独立 inflight 可取消 → 恒 false
      isInProgress: computed(() => false),
      abort: undefined,
      visual: {
        boxClass: forkBoxClass,
        placeholder: forkPlaceholder,
        chipLabelKey: 'panel.composer.forkChip',
        chipIcon: GitFork,
      },
    }
  }

  return {
    forkMode,
    forkModeRef,
    enterForkMode,
    exitForkMode,
    forkBoxClass,
    forkPlaceholder,
    handleForkEsc,
    handleForkSend,
    asStagingAction,
  }
}
