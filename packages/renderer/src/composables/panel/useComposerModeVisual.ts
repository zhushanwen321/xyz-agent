/**
 * useComposerModeVisual —— Composer composer-box 的视觉派生（class / placeholder）。
 *
 * 从 Composer.vue 拆出（script setup ≤300 行规范）。职责：
 * - boxClass：composer-box 的 class，二级优先级 staging 活跃 > 默认（流式 steer 呼吸 / 输入聚焦 ring）
 * - placeholder：输入框 placeholder 文案，二级优先级 staging 活跃 > 默认（流式 steerHint / 普通 inputHint）
 *
 * staging 视觉真源在 useComposerStaging.activeStaging.visual（聚合 fork/handoff 各自 boxClass/placeholder），
 * 这里只做「staging 活跃 + 默认态」聚合，避免 Composer.vue 重复维护两条优先级链。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'

/** 默认态视觉派生依赖（由 Composer 注入 staging 视觉真源 + 状态） */
interface ModeVisualDeps {
  /** staging 活跃时的 box class（从 activeStaging.visual.boxClass 派生；非活跃返回空串） */
  stagingBoxClass: ComputedRef<string>
  /** staging 活跃时的 placeholder（从 activeStaging.visual.placeholder 派生；非活跃返回 null） */
  stagingPlaceholder: ComputedRef<string | null>
  /** session 是否活跃（流式/派发）—— 默认态区分 steer 呼吸 vs 聚焦 ring */
  isActive: ComputedRef<boolean>
  /** 是否有输入（draft 非空）—— 默认态无输入时不画 ring */
  hasInput: ComputedRef<boolean>
  /** 是否发送中 —— 发送中 composer-box 半透明。Composer 持 ref，模式 composable 持 computed，故取并集 */
  isSending: Ref<boolean> | ComputedRef<boolean>
  /**
   * bash 模式（composer-bash-execute）：draft 以 `!` 前缀触发，accent 边框 + bash placeholder。
   * 与 staging 模式不同，bash 不是「模式开关」而是 draft 派生的瞬时态，优先级低于 staging
   * （staging 模式时 bash 视觉不叠加），高于默认态。
   */
  isBashMode?: ComputedRef<boolean>
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

  /**
   * composer-box class：staging 活跃 > bash 模式 > 流式 steer 呼吸 > 普通聚焦 ring；发送中叠半透明。
   * bash 模式优先级低于 staging（staging 是显式模式开关，bash 仅 draft 前缀派生），
   * 避免在 staging 模式下被 bash 前缀输入覆盖视觉。
   *
   * 灰阶化（main-fusion W4 / §13.2-E）：bash 模式视觉从 main 的 --warning（鲜橙，且 token 已被
   * W1 重命名为 --warn，原 --warning 不再生效——merge 带入的遗留失效 class）改为 --accent 边 +
   * --accent-soft 外发光，与 staging 模式同视觉语言（accent=命令模式强调）。语义对齐：
   * bash 是用户主动发起的命令执行，accent 强调与 staging 一致，不走 warning 的告警语义。
   */
  const boxClass = computed<Array<string | false>>(() => [
    deps.stagingBoxClass.value
      || (deps.isBashMode?.value
        ? 'composer-bash-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.30))]'
        : deps.isActive.value
          ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)] animate-steer-breathe'
          : deps.hasInput.value
            ? 'border-[var(--border-strong)] shadow-[0_0_0_2px_rgba(255,255,255,0.04)]'
            : ''),
    deps.isSending.value && 'opacity-[0.55]',
  ])

  /** placeholder：staging > bash > 流式 steerHint / 普通 inputHint */
  const placeholder = computed(
    () =>
      deps.stagingPlaceholder.value
      ?? (deps.isBashMode?.value
        ? t('panel.composer.bashPlaceholder')
        : deps.isActive.value
          ? t('panel.composer.steerHint')
          : t('panel.composer.inputHint')),
  )

  return { boxClass, placeholder }
}
