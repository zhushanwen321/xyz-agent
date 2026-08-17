/**
 * useWorkflowListSync —— workflow 列表的响应式同步（features 层跨 store 编排）。
 *
 * 职责：封装「workflow 列表何时该首拉」的决策。两个触发源：
 * 1. focusedSessionId 变化（切会话）→ loadWorkflows 首拉 RPC
 * 2. workflows tab 激活 + focusedSessionId 变化 → loadWorkflows 首拉 RPC
 *
 * 状态更新（含非活跃 session 的 workflow 终态增量信号）走 useConnection.routeInbound 兜底
 * （session.workflowUpdate → workflowStore.triggerWorkflowReload），不在此订阅。本 composable 只负责首拉 RPC。
 *
 * 调用方：Sidebar.vue 在 onMounted 调用一次。watch 的生命周期跟随组件。
 */
import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePanelStore } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useWorkflowStore } from '@/stores/workflow'

export function useWorkflowListSync(): void {
  const panel = usePanelStore()
  const sidebar = useSidebarStore()
  const workflowStore = useWorkflowStore()

  /**
   * 当前焦点 session（store.focusedSessionId，UI 高亮的真相源）。
   * v2 split 移除后直接读 store computed（此前 local computed 从 panels.find 派生，单 panel 下冗余）。
   */
  const { focusedSessionId } = storeToRefs(panel)

  /**
   * 切会话时首拉 RPC 兜底（推送可能晚到，RPC 立即拿到当前列表）。
   * 实时增量信号（session.workflowUpdate）由 routeInbound 兜底统一处理，不再 per-focus 订阅。
   */
  watch(
    () => focusedSessionId.value,
    (sid) => {
      if (sid) {
        void workflowStore.loadWorkflows(sid)
      }
    },
    { immediate: true },
  )

  /**
   * workflows tab 激活时加载 workflow 列表（tab 切换的首拉）。
   * immediate:true 保证 Sidebar 挂载时如果当前 tab 已是 workflows，立即拉取——
   * 首个 watch 的 immediate 已处理切会话首拉，这里补 tab 已激活的边界。
   */
  watch(
    () => [sidebar.activeTab, focusedSessionId.value] as const,
    ([tab, sid]) => {
      if (tab === 'workflows' && sid) {
        void workflowStore.loadWorkflows(sid)
      }
    },
    { immediate: true },
  )
}
