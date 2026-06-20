/**
 * Session store —— session 列表 + D6 派生 status。
 *
 * 依赖方向：无（stores 间禁止互相 import；跨 store 协调由 composables/features 做）。
 * 骨架阶段：state/getter 合法初始值，action throw。
 * derivedStatus 骨架返回 computed(() => 'waiting')（合法默认，不 throw 以保响应式）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'
import type { DerivedStatus } from '@/types'

export const useSessionStore = defineStore('session', () => {
  const list = ref<SessionSummary[]>([])
  const activeId = ref<string | null>(null)

  const active = computed<SessionSummary | null>(
    () => list.value.find((s) => s.id === activeId.value) ?? null,
  )

  /**
   * 派生 session 5 态（D6：从 message/tool 状态派生）。
   * 骨架阶段返回合法默认 'waiting'，实现阶段填派生逻辑。
   */
  function derivedStatus(id: string): ComputedRef<DerivedStatus> {
    // ponytail: 骨架默认 'waiting'，实现阶段从 message/tool 状态派生（D6）
    void id
    return computed(() => 'waiting' as DerivedStatus)
  }

  return { list, activeId, active, derivedStatus }
})
