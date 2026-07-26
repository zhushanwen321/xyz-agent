/**
 * useComposerModeVisual —— Composer composer-box 的视觉派生（class / placeholder）。
 *
 * 从 Composer.vue 拆出（script setup ≤300 行规范）。职责：
 * - boxClass：composer-box 的 class，三级优先级 fork 模式 > handoff 模式 > 默认（流式 steer 呼吸 / 输入聚焦 ring）
 * - placeholder：输入框 placeholder 文案，三级优先级 fork > handoff > 默认（流式 steerHint / 普通 inputHint）
 *
 * 三级链的 fork / handoff 视觉真源在各自模式 composable（forkBoxClass/handoffBoxClass 等），
 * 这里只做「模式优先级 + 默认态」聚合，避免 Composer.vue 重复维护两条三级链。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'

/** 默认态视觉派生依赖（由 Composer 注入模式真源 + 状态） */
interface ModeVisualDeps {
  /** fork 模式 composer-box class（非 fork 模式返回空串） */
  forkBoxClass: ComputedRef<string>
  /** handoff 模式 composer-box class（非 handoff 模式返回空串） */
  handoffBoxClass: ComputedRef<string>
  /** fork 模式 placeholder（非 fork 模式返回 null） */
  forkPlaceholder: ComputedRef<string | null>
  /** handoff 模式 placeholder（非 handoff 模式返回 null） */
  handoffPlaceholder: ComputedRef<string | null>
  /** session 是否活跃（流式/派发）—— 默认态区分 steer 呼吸 vs 聚焦 ring */
  isActive: ComputedRef<boolean>
  /** 是否有输入（draft 非空）—— 默认态无输入时不画 ring */
  hasInput: ComputedRef<boolean>
  /** 是否发送中 —— 发送中 composer-box 半透明。Composer 持 ref，模式 composable 持 computed，故取并集 */
  isSending: Ref<boolean> | ComputedRef<boolean>
}

/**
 * @param deps 模式视觉真源 + 状态
 * @returns boxClass（composer-box class 三级链）/ placeholder（输入框文案三级链）
 */
export function useComposerModeVisual(deps: ModeVisualDeps): {
  boxClass: ComputedRef<Array<string | false>>
  placeholder: ComputedRef<string>
} {
  const { t } = useI18n()

  /** composer-box class：fork/handoff 模式 > 流式 steer 呼吸 > 普通聚焦 ring；发送中叠半透明 */
  const boxClass = computed<Array<string | false>>(() => [
    deps.forkBoxClass.value
      || deps.handoffBoxClass.value
      || (deps.isActive.value
        ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)] animate-steer-breathe'
        : deps.hasInput.value
          ? 'border-[var(--border-strong)] shadow-[0_0_0_2px_rgba(255,255,255,0.04)]'
          : ''),
    deps.isSending.value && 'opacity-[0.55]',
  ])

  /** placeholder：fork > handoff > 流式 steerHint / 普通 inputHint */
  const placeholder = computed(
    () =>
      deps.forkPlaceholder.value
      ?? deps.handoffPlaceholder.value
      ?? (deps.isActive.value ? t('panel.composer.steerHint') : t('panel.composer.inputHint')),
  )

  return { boxClass, placeholder }
}
