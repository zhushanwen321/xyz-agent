/**
 * useWorkflowDrawerTabs —— workflow drawer 二级 tab 状态管理（W1 wave，W3 改单例）。
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
 *
 * [W3] 单例化（对齐 useSideDrawer）：state 从 per-call useSessionScopedState 提升为模块级单例。
 * 原因：W3 接入后有两个调用方——WorkflowDrawerPane（读 openedRunIds）+ useSidebarSubagentActions
 * （openWorkflow 副作用）。useSessionScopedState 每次调用建自己的 Map（per-instance），若 useWorkflowDrawerTabs
 * 每次调用也建独立 state，两调用方状态不共享 → sidebar 点击 openWorkflow 后 drawer 不更新。
 * 提升为模块级单例后所有调用方共享同一 Map 分区，跨组件状态同步。
 *
 * 分区键：panelStore.focusedSessionId（与 useSideDrawer 同源，active panel 绑定的 sessionId）。
 * lazy 调 usePanelStore()（模块加载时 pinia 可能未初始化，computed 首次求值时已 active）。
 */
import { computed } from "vue";
import type { ComputedRef } from "vue";
import { reactive } from "vue";
import { useSessionScopedState } from "@/composables/useSessionScopedState";
import { usePanelStore } from "@/stores/panel";

/** 二级 tab 状态：runId → 打开时间戳（排序用）。 */
export interface OpenedRunsState {
  openedRuns: Map<string, number>;
}

/**
 * 模块级分区键：active panel 绑定的 sessionId（与 useSideDrawer.focusedSessionId 同源）。
 * lazy 调 usePanelStore()（computed 首次求值时 pinia 已 active，避免模块加载期 pinia 未初始化）。
 */
const focusedSessionId = computed<string | null>(
  () => usePanelStore().focusedSessionId
);

/**
 * 模块级单例 state（per-session 分区，ADR-0036 Map 分区派）。
 * init 必须返回 reactive 容器（ADR-0036 响应式契约）。
 * Map 包在 reactive({}) 内 → reactive 深度代理 Map，mutate 触发下游 computed。
 */
const state = useSessionScopedState<OpenedRunsState>(focusedSessionId, () =>
  reactive<OpenedRunsState>({ openedRuns: new Map() })
);

/**
 * 重置 workflow drawer tabs 状态（测试隔离用）。清所有 per-session 分区。
 * 生产代码不应调用。
 */
export function resetWorkflowDrawerTabs(): void {
  state._clearAllForTest?.();
}

/** 打开 workflow run 的二级 tab。UI 操作用 update（读 focusedSessionId 实时值）。 */
function openWorkflow(runId: string): void {
  state.update((s) => {
    s.openedRuns.set(runId, Date.now());
  });
}

/** 关闭 workflow run 的二级 tab。 */
function closeWorkflow(runId: string): void {
  state.update((s) => {
    s.openedRuns.delete(runId);
  });
}

/** 查询某 run 的 tab 是否打开（读当前 session 分区）。 */
function isWorkflowOpened(runId: string): boolean {
  return state.current.value.openedRuns.has(runId);
}

/**
 * 当前 session 下打开的 runId 列表，按打开时间戳 DESC 排序（最近打开在前）。
 * Map 是响应式的（包在 reactive 容器内），computed 在 openedRuns 上建立依赖。
 */
const openedRunIds = computed<string[]>(() => {
  const runs = state.current.value.openedRuns;
  return Array.from(runs.entries())
    .sort((a, b) => b[1] - a[1]) // value DESC：最近打开在前
    .map(([runId]) => runId);
});

/**
 * 管理 workflow drawer 二级 tab 的打开/关闭状态（per-session 隔离，模块级单例）。
 *
 * [W3] 无参：状态为模块级单例（对齐 useSideDrawer），所有调用方共享同一分区 Map。
 * 分区键来自 panelStore.focusedSessionId（模块级 focusedSessionId computed）。
 *
 * @returns
 *   - openedRunIds：当前 session 下打开的 runId 列表，按打开时间 DESC 排序（最近打开在前）
 *   - openWorkflow(runId)：打开某 run 的二级 tab（set runId → Date.now()）
 *   - closeWorkflow(runId)：关闭某 run 的二级 tab（delete）
 *   - isWorkflowOpened(runId)：查询某 run 的 tab 是否打开
 */
export function useWorkflowDrawerTabs(): {
  openedRunIds: ComputedRef<string[]>;
  openWorkflow: (runId: string) => void;
  closeWorkflow: (runId: string) => void;
  isWorkflowOpened: (runId: string) => boolean;
  } {
  return {
    openedRunIds,
    openWorkflow,
    closeWorkflow,
    isWorkflowOpened,
  };
}
