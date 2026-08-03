/**
 * useComposerHandoffMode —— deps 组装 shim（W3 composer-dispatch-context）。
 *
 * [归位] 逻辑已迁 @xyz-agent/core/domain/composer/dispatch/handoff-mode.ts（W3）。
 * core 版把 5 个跨域能力（t/handoffChipIcon/toastError/isHandingOff/handoffEnterSignal）
 * 从 renderer import 改为 HandoffDeps 注入字段（core 零 renderer import）。
 * 本 shim 保持旧签名（deps 不含这 5 字段），内部从 renderer store/composable
 * 取真实能力组装完整 deps 调 core 版。
 *
 * 旧调用方（Composer.vue）零改动。
 *
 * W4 壳接入时删除本 shim。
 */
import { useI18n } from 'vue-i18n'
import { Upload } from '@lucide/vue'
import { useToast } from '@/composables/useToast'
import { useChatStore } from '@/stores/chat'
import { useHandoffModeChannel } from '@/composables/panel/useHandoffModeChannel'
import {
  useComposerHandoffMode as useCoreComposerHandoffMode,
  type HandoffDeps,
} from '@xyz-agent/core/domain/composer/dispatch'

/** 旧调用方 deps 类型（core deps 减 5 跨域字段——shim 注入） */
type LegacyHandoffDeps = Omit<HandoffDeps, 't' | 'handoffChipIcon' | 'toastError' | 'isHandingOff' | 'handoffEnterSignal'>

export function useComposerHandoffMode(
  sessionId: Parameters<typeof useCoreComposerHandoffMode>[0],
  deps: LegacyHandoffDeps,
) {
  const { t } = useI18n()
  const { error: toastError } = useToast()
  const chatStore = useChatStore()
  const { signal: handoffEnterSignal } = useHandoffModeChannel()
  return useCoreComposerHandoffMode(sessionId, {
    ...deps,
    t: t as (key: string, params?: Record<string, unknown>) => string,
    handoffChipIcon: Upload,
    toastError,
    isHandingOff: (sid: string) => chatStore.isHandingOff(sid),
    handoffEnterSignal,
  })
}
