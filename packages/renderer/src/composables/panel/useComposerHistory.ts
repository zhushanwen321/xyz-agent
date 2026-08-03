/**
 * useComposerHistory —— renderer 兼容 shim（W2 迁移过渡期）。
 *
 * 真实实现已迁入 @xyz-agent/core/domain/composer/input/history.ts。本文件为 re-export 兼容层：
 * 保持 Composer.vue 等旧调用方的 import 路径与签名零改动，内部组装 core 版所需的 getHistoryEntries
 * 注入（core 不能 import @/stores/chat，跨域禁止 D4/AC10）。
 *
 * W4 壳接入时删除本 shim，Composer.vue 改为直接 import core + 直接组装 deps。
 *
 * [W2 改造] 原 deps 不含 getHistoryEntries（W2 新增，替代 chatStore 派生），shim 自动注入。
 * chatStore 历史派生逻辑（role==='user' && status==='complete'，倒序，去重连续相同文本）
 * 从原 history computed 抽出为 deriveHistoryFromChatStore 纯函数留壳层。
 */
import type { Ref } from 'vue'
import { useComposerHistory as useCoreComposerHistory } from '@xyz-agent/core/domain/composer/input'
import type { HistoryDeps } from '@xyz-agent/core/domain/composer/input'
import { useChatStore } from '@/stores/chat'
import { normalizeContent } from '@xyz-agent/shared'

/** 旧 deps 类型（不含 W2 新增的 getHistoryEntries，由 shim 注入） */
type LegacyHistoryDeps = Omit<HistoryDeps, 'getHistoryEntries'>

/**
 * 从 chatStore 派生历史条目（倒序 + 去重连续相同文本）。
 *
 * [W2 抽取] 原为 useComposerHistory 内的 history computed，core 迁移后上移壳层（靠近 chatStore），
 * core 经 deps.getHistoryEntries 注入消费。逻辑与原 computed byte-for-byte 一致。
 */
function deriveHistoryFromChatStore(chatStore: ReturnType<typeof useChatStore>, sid: string): string[] {
  const msgs = chatStore.getMessages(sid)
  const result: string[] = []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'user' || m.status !== 'complete') continue
    const text = normalizeContent(m.content)
    if (result.length > 0 && result[result.length - 1] === text) continue
    result.push(text)
  }
  return result
}

export function useComposerHistory(sessionIdRef: Ref<string | null>, deps: LegacyHistoryDeps) {
  const chatStore = useChatStore()
  // 原地丰富 deps（加 getHistoryEntries），保持引用语义——支持调用方后续 mutate
  // deps.getText/deps.setText 的测试范式（与原 renderer 版直接用传入 deps 引用的行为一致）。
  // 若用 {...deps} 展开复制，core 持有副本，调用方对原 deps 的 mutate 不生效。
  const enrichedDeps = Object.assign(deps, {
    getHistoryEntries: (sid: string) => deriveHistoryFromChatStore(chatStore, sid),
  }) as HistoryDeps
  return useCoreComposerHistory(sessionIdRef, enrichedDeps)
}
