/**
 * useComposerHandoffMode —— Composer 的 handoff（交接）模式（fast-handoff，参照 useComposerForkMode）。
 *
 * 从 Composer.vue 拆出（script setup 行数合规）。职责：
 * - handoffMode 状态真源：是否处于「从末条 assistant 交接」的备注模式
 * - handoffSource：记录 handoff 来源（srcSessionId = handoff 出发的 session）
 * - enterHandoffMode / exitHandoffMode：进入（记来源 + 聚焦输入框 + 互斥退出 fork 模式）/ 退出（复位状态）
 * - 跨组件触发通道：watch useHandoffModeChannel 的 signal（Sidebar ⌘J 请求），命中本 session 时 enterHandoffMode
 * - handoffBoxClass / handoffPlaceholder：handoff 模式派生的 class 与 placeholder 文案
 * - handleHandoffEsc：Esc 退出（清空输入 + exitHandoffMode），返回是否已消费
 * - handleHandoffSend：handoff 模式发送（调 handoff(srcId, text) + 退出），返回是否已消费
 * - handoffModeRef：{ value: boolean } 包装对象，给 defineExpose 用（避免 Vue 解包顶层 ref）
 *
 * 与 fork 模式互斥：进 handoff 前退出 fork（deps.exitForkMode）；fork 模式自身进 handoff 时也对称退出。
 * 发送/清空输入等副作用通过 deps 注入（Composer 持有 draft/isSending/clearInput/restoreInput 真源），
 * 保持 handoff 状态真源单一且不侵入 Composer 已稳定的发送/草稿流程。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useHandoffModeChannel } from '@/composables/panel/useHandoffModeChannel'
import type ComposerInput from '@/components/panel/ComposerInput.vue'

/** useComposerHandoffMode 返回类型（从函数内联类型提取为命名 interface，便于复用 + 阅读） */
export interface ComposerHandoffModeReturn {
  handoffMode: Ref<boolean>
  /** { value: boolean } 包装对象，给 defineExpose 用（不被 Vue 解包） */
  handoffModeRef: { readonly value: boolean }
  enterHandoffMode: (srcSessionId: string) => void
  exitHandoffMode: () => void
  /** handoff 模式 composer-box class（accent 边 + glow + accent-soft 底）；非 handoff 模式返回空串 */
  handoffBoxClass: ComputedRef<string>
  /** handoff 模式 placeholder 文案；非 handoff 模式返回 null */
  handoffPlaceholder: ComputedRef<string | null>
  /** Esc 处理：handoff 模式下清空输入 + 退出，返回 true 表示已消费；否则返回 false */
  handleHandoffEsc: (e: KeyboardEvent) => boolean
  /** handoff 模式发送：调 handoff(srcId, text) + exitHandoffMode，返回 true 表示已消费；否则返回 false */
  handleHandoffSend: (text: string) => Promise<boolean>
}

/** handoff 发送副作用依赖（由 Composer 注入，避免重复持有 draft/isSending 真源） */
interface HandoffDeps {
  /** ComposerInput 实例 ref：enterHandoffMode 聚焦输入框用 */
  inputRef: Ref<InstanceType<typeof ComposerInput> | null>
  /** 发送中标志位 setter（handoff 发送期间置 true，结束复位） */
  setSending: (value: boolean) => void
  /** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
  clearInput: () => void
  /** 发送失败时恢复草稿到输入区 */
  restoreInput: (text: string) => void
  /** 互斥：进入 handoff 模式时退出 fork 模式（forkSource 残留指向错误 session） */
  exitForkMode: () => void
  /** handoff 编排（features 层跨 api + stores）：handleHandoffSend 调用触发 handoff（runtime agent-driven） */
  handoff: (srcSessionId: string, reply?: string) => Promise<void>
}

/**
 * @param sessionId 当前 session id（null = landing 态，signal 守卫用）
 * @param deps 发送副作用依赖（含 exitForkMode 做互斥）
 */
export function useComposerHandoffMode(
  sessionId: ComputedRef<string | null>,
  deps: HandoffDeps,
): ComposerHandoffModeReturn {
  const { t } = useI18n()
  const { error: toastError } = useToast()
  // handoff 编排经 deps 注入（Composer 从 useSidebar 取，避免本 composable 重复实例化 useSidebar）。
  const handoffAction = deps.handoff

  /** handoff 模式开关：true 时 composer 顶部显 mode-chip + 视觉，发送走 handoff */
  const handoffMode = ref(false)
  /** handoff 来源：srcSessionId（handoff 出发的 session；无 fromMessageId，始终从末条 assistant 打包） */
  const handoffSource = ref<{ srcSessionId: string } | null>(null)

  function enterHandoffMode(srcSessionId: string): void {
    // 互斥：进 handoff 前退出 fork 模式（避免 forkSource 残留 + 两个模式同时活跃）
    deps.exitForkMode()
    handoffSource.value = { srcSessionId }
    handoffMode.value = true
    // 聚焦输入框，让用户立即键入 focus 备注
    deps.inputRef.value?.focus?.()
  }

  function exitHandoffMode(): void {
    handoffMode.value = false
    handoffSource.value = null
  }

  // 跨组件触发通道：Sidebar 全局快捷键（⌘J → enterHandoffModeFromLastAssistant）经 signal
  // 请求 Composer 进 handoff 模式。Composer 仍是 handoffMode 状态真源。
  const { signal: handoffEnterSignal } = useHandoffModeChannel()
  watch(handoffEnterSignal, (req) => {
    if (!req) return
    // signal 只对当前 panel composer 生效：srcSessionId 必须是本 composer 的 session，
    // 避免双 panel 下快捷键误触发非焦点 panel 的 composer。
    if (req.srcSessionId !== sessionId.value) return
    enterHandoffMode(req.srcSessionId)
  })

  /** handoff 模式视觉 class（accent 边 + glow + accent-soft 底）；非 handoff 模式返回空串 */
  const handoffBoxClass = computed(() =>
    handoffMode.value
      ? 'handoff-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.45))] bg-[var(--accent-soft)]'
      : '',
  )

  /** handoff 模式 placeholder 文案；非 handoff 模式返回 null */
  const handoffPlaceholder = computed(() => (handoffMode.value ? t('panel.composer.handoffHint') : null))

  /**
   * Esc 处理：handoff 模式下清空输入 + 退出。
   * @returns true 表示已消费（composer 聚焦时优先于全局 Esc handler）
   */
  function handleHandoffEsc(e: KeyboardEvent): boolean {
    if (!handoffMode.value || e.key !== 'Escape') return false
    e.preventDefault()
    deps.clearInput()
    exitHandoffMode()
    return true
  }

  /**
   * handoff 模式发送：调 handoff(srcSessionId, text)（runtime 让源 session 跑 handoff turn 提取末条 assistant 文档到新 session）。
   * reply=text sanitize 后拼到 handoff prompt 末尾告知 agent 下一 session 关注点（用户备注）。
   * 成功后退出 handoff 模式（等 session.handoffComplete 广播跳转）；
   * 失败时 restoreInput 保草稿 + toast 反馈。
   * @param text 当前 draft（作 handoff reply 备注）
   * @returns true 表示已消费（onSend 开头短路，不走普通 send 流程）；非 handoff 模式返回 false
   */
  async function handleHandoffSend(text: string): Promise<boolean> {
    if (!handoffMode.value || !handoffSource.value) return false
    const { srcSessionId } = handoffSource.value
    // reply 备注可选：空文本也允许（runtime handoff turn 无 reply 时只发 template）。空则 undefined 不传 reply。
    const reply = text.trim() || undefined
    deps.clearInput()
    deps.setSending(true)
    try {
      await handoffAction(srcSessionId, reply)
    } catch (e) {
      // handoff 触发失败 → restoreInput 保草稿（与 fork handleForkSend 对称）
      deps.restoreInput(text)
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('panel.message.handoffFailed', { error: msg }))
    } finally {
      deps.setSending(false)
      exitHandoffMode()
    }
    return true
  }

  /**
   * { value: boolean } 包装对象（非 ref，不被 defineExpose 解包），其 value 经 getter
   * 代理到响应式 handoffMode ref，既保留响应式又对齐 vm.handoffMode.value 访问契约。
   */
  const handoffModeRef = {
    get value(): boolean {
      return handoffMode.value
    },
  }

  return {
    handoffMode,
    handoffModeRef,
    enterHandoffMode,
    exitHandoffMode,
    handoffBoxClass,
    handoffPlaceholder,
    handleHandoffEsc,
    handleHandoffSend,
  }
}
