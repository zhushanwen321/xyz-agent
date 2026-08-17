/**
 * useSubagentListSync —— subagent 列表的响应式同步（features 层跨 store 编排）。
 *
 * 职责：封装「subagent 列表何时该首拉」的决策。两个触发源：
 * 1. focusedSessionId 变化（切会话）→ loadSubagents 首拉 RPC
 * 2. subagents tab 激活 + focusedSessionId 变化 → loadSubagents 首拉 RPC
 *
 * 状态更新（含非活跃 session 的 subagent 终态推送）走 useConnection.routeInbound 兜底
 * （session.subagents → subagentStore.applyRecords），不在此订阅。本 composable 只负责首拉 RPC。
 *
 * 调用方：Sidebar.vue 在 onMounted 调用一次。watch 的生命周期跟随组件。
 */
import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePanelStore } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useSubagentStore } from '@/stores/subagent'

export function useSubagentListSync(): void {
  const panel = usePanelStore()
  const sidebar = useSidebarStore()
  const subagentStore = useSubagentStore()

  /**
   * 当前焦点 session（store.focusedSessionId，UI 高亮的真相源）。
   * v2 split 移除后直接读 store computed（此前 local computed 从 panels.find 派生，单 panel 下冗余）。
   */
  const { focusedSessionId } = storeToRefs(panel)

  /**
   * 切会话时首拉 RPC 兜底（推送可能晚到，RPC 立即拿到当前列表）。
   * 实时推送（session.subagents 终态更新）由 routeInbound 兜底统一处理，不再 per-focus 订阅。
   */
  watch(
    () => focusedSessionId.value,
    (sid) => {
      if (sid) {
        void subagentStore.loadSubagents(sid)
      }
    },
    { immediate: true },
  )

  /**
   * subagents tab 激活时加载 subagent 列表（tab 切换的首拉）。
   * 与兜底互补：routeInbound 处理「运行时实时变化」，这里处理「用户主动切到 subagents tab」。
   */
  watch(
    () => [sidebar.activeTab, focusedSessionId.value] as const,
    ([tab, sid]) => {
      if (tab === 'subagents' && sid) {
        void subagentStore.loadSubagents(sid)
      }
    },
  )
}
