/**
 * useComposerBash —— deps 组装 shim（W3 composer-dispatch-context）。
 *
 * [归位] 逻辑已迁 @xyz-agent/core/domain/composer/dispatch/bash.ts（W3）。
 * core 版把 sendBash 从内部 useChat() 调用改为 ComposerBashOptions 注入字段
 * （core 零 renderer import）。本 shim 保持旧签名（opts: ComposerBashOptions），
 * 内部从 useChat() 取 sendBash 组装完整 deps 调 core 版。
 *
 * 注意：从 dispatch barrel import（core exports 只暴露 ./domain/composer/dispatch
 * 子路径，不暴露单文件 bash 子路径）。
 *
 * Composer.vue 等旧调用方零改动。
 *
 * W4 壳接入时删除本 shim。
 */
import type { Ref, ComputedRef } from 'vue'
import { useChat } from '@/composables/features/useChat'
import { useComposerBash as useCoreComposerBash } from '@xyz-agent/core/domain/composer/dispatch'

// 旧签名类型（与 core 版 ComposerBashOptions 一致，shim 层透传）
export type BashCommandExtract =
  | { type: 'not-bash' }
  | { type: 'empty' }
  | { type: 'command'; command: string; excludeFromContext: boolean }

export interface ComposerBashOptions {
  draft: Ref<string>
  clearInput: () => void
  isSending: Ref<boolean>
  sessionId: () => string | null
}

export interface UseComposerBash {
  isBashMode: ComputedRef<boolean>
  extractBashCommand: (text: string) => BashCommandExtract
  trySendBash: (rawText: string) => Promise<boolean>
}

export function useComposerBash(opts: ComposerBashOptions): UseComposerBash {
  const { sendBash } = useChat()
  return useCoreComposerBash({ ...opts, sendBash })
}
