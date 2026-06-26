/**
 * session store 桩（useNewTaskFlow 读 session.list / activeId 派生 gitInfo）。
 *
 * 骨架简化：真实 store 基于 pinia（src-electron/renderer/src/stores/session.ts，未改动），
 * pinia 仅在 src-electron/node_modules 下，code-skeleton 解析不到 → 用模块级响应式单例替代，
 * 仅暴露 NewTaskFlow 链路用到的响应式状态。接线语义不变（composable 仍读响应式 list/activeId）。
 */
import { ref, computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'

const list: Ref<SessionSummary[]> = ref([])
const activeId: Ref<string | null> = ref(null)

/** 当前活跃 session 摘要（gitInfo 派生源） */
const activeSummary: ComputedRef<SessionSummary | null> = computed(
  () => list.value.find((s) => s.id === activeId.value) ?? null,
)

export function useSessionStore() {
  return { list, activeId, activeSummary }
}
