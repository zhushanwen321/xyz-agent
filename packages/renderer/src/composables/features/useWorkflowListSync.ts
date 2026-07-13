/**
 * useWorkflowListSync —— workflow 列表的响应式同步（features 层跨 store 编排）。
 *
 * 职责：封装「workflow 列表何时该刷新」的完整决策。
 * 两个触发源：
 * 1. focusedSessionId 变化（切会话）→ clearWorkflows 先清空 + 首拉 RPC
 * 2. workflows tab 激活 + focusedSessionId 变化 → loadWorkflows 首拉 RPC
 *
 * 实时推送（session.workflows 增量信号 → loadWorkflows RPC 拉取）在 W3 加入。
 *
 * 调用方：Sidebar.vue 在 onMounted 调用一次。watch 的生命周期跟随组件。
 */
import { computed, watch } from 'vue'
import { usePanelStore } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useWorkflowStore } from '@/stores/workflow'

export function useWorkflowListSync(): void {
  const panel = usePanelStore()
  const sidebar = useSidebarStore()
  const workflowStore = useWorkflowStore()

  /**
   * 当前焦点 session（与 useSidebar.focusedSessionId 同源）。
   * panel store 的 activePanelId → sessionId 是 UI 高亮的真相源。
   */
  const focusedSessionId = computed<string | null>(
    () => panel.panels.find((p) => p.id === panel.activePanelId)?.sessionId ?? null,
  )

  /**
   * 切会话时：
   * 1. clearWorkflows 清空旧数据（消除残留窗口）
   * 2. 首拉 RPC（新 session 的 workflow 列表）
   */
  watch(
    () => focusedSessionId.value,
    (sid) => {
      workflowStore.clearWorkflows()
      if (sid) {
        void workflowStore.loadWorkflows(sid)
      }
    },
    { immediate: true },
  )

  /**
   * workflows tab 激活时加载 workflow 列表（tab 切换的首拉）。
   */
  watch(
    () => [sidebar.activeTab, focusedSessionId.value] as const,
    ([tab, sid]) => {
      if (tab === 'workflows' && sid) {
        void workflowStore.loadWorkflows(sid)
      }
    },
  )
}
