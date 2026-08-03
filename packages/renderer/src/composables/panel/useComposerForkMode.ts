/**
 * useComposerForkMode —— deps 组装 shim（W3 composer-dispatch-context）。
 *
 * [归位] 逻辑已迁 @xyz-agent/core/domain/composer/dispatch/fork-mode.ts（W3）。
 * core 版把 5 个跨域能力（t/forkChipIcon/forkSessionAsk/toastError/forkEnterSignal）
 * 从 renderer import 改为 ForkDeps 注入字段（core 零 renderer import）。
 * 本 shim 保持旧签名（deps 不含这 5 字段），内部从 renderer store/composable
 * 取真实能力组装完整 deps 调 core 版。
 *
 * 旧调用方（Composer.vue）零改动。
 *
 * W4 壳接入时删除本 shim。
 */
import { useI18n } from 'vue-i18n'
import { GitFork } from '@lucide/vue'
import { useSidebar } from '@/composables/features/useSidebar'
import { useToast } from '@/composables/useToast'
import { useForkModeChannel } from '@/composables/panel/useForkModeChannel'
import {
  useComposerForkMode as useCoreComposerForkMode,
  type ForkDeps,
} from '@xyz-agent/core/domain/composer/dispatch'

/** 旧调用方 deps 类型（core deps 减 5 跨域字段——shim 注入） */
type LegacyForkDeps = Omit<ForkDeps, 't' | 'forkChipIcon' | 'forkSessionAsk' | 'toastError' | 'forkEnterSignal'>

export function useComposerForkMode(
  sessionId: Parameters<typeof useCoreComposerForkMode>[0],
  deps: LegacyForkDeps,
) {
  const { t } = useI18n()
  const { error: toastError } = useToast()
  const { signal: forkEnterSignal } = useForkModeChannel()
  const sidebar = useSidebar()
  return useCoreComposerForkMode(sessionId, {
    ...deps,
    t: t as (key: string, params?: Record<string, unknown>) => string,
    forkChipIcon: GitFork,
    forkSessionAsk: sidebar.forkSessionAsk,
    toastError,
    forkEnterSignal,
  })
}
