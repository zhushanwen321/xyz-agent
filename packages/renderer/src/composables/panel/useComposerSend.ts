/**
 * useComposerSend —— deps 组装 shim（W3 composer-dispatch-context）。
 *
 * [归位] 逻辑已迁 @xyz-agent/core/domain/composer/dispatch/send.ts（W3）。
 * core 版把 useCompactQueue().enqueue 直调改为 ComposerSendDeps.enqueueCompact 注入字段
 * （core 零 renderer import）。本 shim 保持旧签名（deps 不含 enqueueCompact），
 * 内部从 useCompactQueue() 取 enqueue 组装完整 deps 调 core 版。
 *
 * 旧调用方（Composer.vue）传的 deps 结构与 core ComposerSendDeps 一致（除 enqueueCompact），
 * shim 参数类型用 Omit<CoreDeps, 'enqueueCompact'> 让 TS 结构匹配。
 *
 * Composer.vue 等旧调用方零改动。
 *
 * W4 壳接入时删除本 shim。
 */
import { useCompactQueue } from './useCompactQueue'
import {
  useComposerSend as useCoreComposerSend,
  type ComposerSendDeps,
} from '@xyz-agent/core/domain/composer/dispatch'

/** 旧调用方 deps 类型（core deps 减 enqueueCompact——shim 注入） */
type LegacyComposerSendDeps = Omit<ComposerSendDeps, 'enqueueCompact'>

export function useComposerSend(deps: LegacyComposerSendDeps): { onSend: () => Promise<void> } {
  const compactQueue = useCompactQueue()
  return useCoreComposerSend({
    ...deps,
    enqueueCompact: (sessionId: string, text: string) => compactQueue.enqueue(sessionId, text),
  })
}
