/**
 * composer-box 容器 class 派生（slice5 提取，满足 Composer.vue <script setup> ≤300 行约束）。
 *
 * 职责单一：按优先级合并 composer-box 的边框 / 阴影 / 透明度 class。
 * 优先级：fork 模式（accent 边 + ring glow）> 拖拽悬停（accent 边）> S6 流式（steer 呼吸 ring）
 * > S2 输入中（中性 ring）；sending 态追加半透明。
 *
 * @param forkBoxClass  fork 模式 class（fork 真源派生，空串表示非 fork）
 * @param isDragOver    拖拽悬停态（useComposerDragDrop 派生）
 * @param isActive      活跃态（流式 / 派发空窗期）
 * @param hasInput      是否有输入文本
 * @param isSending     发送中（S5）
 */
import { computed, type ComputedRef, type Ref } from 'vue'

export function useComposerBoxClass(
  forkBoxClass: ComputedRef<string> | Ref<string>,
  isDragOver: Ref<boolean>,
  isActive: ComputedRef<boolean> | Ref<boolean>,
  hasInput: ComputedRef<boolean> | Ref<boolean>,
  isSending: Ref<boolean>,
): ComputedRef<Array<string | false>> {
  return computed(() => [
    forkBoxClass.value
      || (isDragOver.value
        ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)]'
        : isActive.value
          ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)] animate-steer-breathe'
          : hasInput.value
            ? 'border-[var(--border-strong)] shadow-[0_0_0_2px_rgba(255,255,255,0.04)]'
            : ''),
    isSending.value && 'opacity-[0.55]',
  ])
}
