/**
 * useWorkflowDrawerTabs —— workflow drawer 二级 tab 状态管理（W1 wave）。
 *
 * 管理用户在 sidebar drawer 中打开了哪些 workflow run 的二级 tab。状态用
 * useSessionScopedState 按 session 分区（遵循 ADR-0036 Map 分区派），天然隔离：
 * 切 session 不泄漏、切回恢复。
 *
 * 数据结构：Map<runId, 打开时间戳>。timestamp 用于排序（最近打开的排前面）。
 *
 * 响应式契约（ADR-0036）：init 工厂返回 reactive({...}) 包裹的 Map。
 * Map 本身包在 reactive 容器内即为响应式（reactive 深度代理 Map 的 get/set/has/delete），
 * computed 在 state.current.value.openedRuns 上建立依赖，mutate 时失效重算。
 */
import { computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { reactive } from 'vue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

/** 二级 tab 状态：runId → 打开时间戳（排序用）。 */
export interface OpenedRunsState {
  openedRuns: Map<string, number>
}

/**
 * 管理 workflow drawer 二级 tab 的打开/关闭状态（per-session 隔离）。
 *
 * @param focusedSessionId 当前聚焦 session 的响应式 id（null 表示无活跃 session）
 * @returns
 *   - openedRunIds：当前 session 下打开的 runId 列表，按打开时间 DESC 排序（最近打开在前）
 *   - openWorkflow(runId)：打开某 run 的二级 tab（set runId → Date.now()）
 *   - closeWorkflow(runId)：关闭某 run 的二级 tab（delete）
 *   - isWorkflowOpened(runId)：查询某 run 的 tab 是否打开
 */
export function useWorkflowDrawerTabs(focusedSessionId: Ref<string | null>): {
  openedRunIds: ComputedRef<string[]>
  openWorkflow: (runId: string) => void
  closeWorkflow: (runId: string) => void
  isWorkflowOpened: (runId: string) => boolean
} {
  // init 必须返回 reactive 容器（ADR-0036 响应式契约）。
  // Map 包在 reactive({}) 内 → reactive 深度代理 Map，mutate 触发下游 computed。
  const state = useSessionScopedState<OpenedRunsState>(focusedSessionId, () =>
    reactive<OpenedRunsState>({ openedRuns: new Map() }),
  )

  /** 打开 workflow run 的二级 tab。UI 操作用 update（读 sid.value 实时值）。 */
  function openWorkflow(runId: string): void {
    state.update((s) => {
      s.openedRuns.set(runId, Date.now())
    })
  }

  /** 关闭 workflow run 的二级 tab。 */
  function closeWorkflow(runId: string): void {
    state.update((s) => {
      s.openedRuns.delete(runId)
    })
  }

  /** 查询某 run 的 tab 是否打开（读当前 session 分区）。 */
  function isWorkflowOpened(runId: string): boolean {
    return state.current.value.openedRuns.has(runId)
  }

  /**
   * 当前 session 下打开的 runId 列表，按打开时间戳 DESC 排序（最近打开在前）。
   * Map 是响应式的（包在 reactive 容器内），computed 在 openedRuns 上建立依赖。
   */
  const openedRunIds = computed<string[]>(() => {
    const runs = state.current.value.openedRuns
    return Array.from(runs.entries())
      .sort((a, b) => b[1] - a[1]) // value DESC：最近打开在前
      .map(([runId]) => runId)
  })

  return {
    openedRunIds,
    openWorkflow,
    closeWorkflow,
    isWorkflowOpened,
  }
}
