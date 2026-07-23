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

  /** 当前 session 的推送订阅取消函数（切会话时取消旧订阅） */
  let unsubPush: (() => void) | null = null

  /**
   * 切会话时：
   * 1. （不再 clearWorkflows——ADR-0036 Map 分区派：切走不清，切回直接读分区）
   * 2. 订阅新 session 的 session.workflowUpdate 推送（旧订阅经 watch onCleanup 自动取消）
   * 3. 首拉 RPC 兜底（推送可能晚到，RPC 立即拿到当前列表）
   *
   * [W3 / W-S1] 资源泄漏修复：改用 watch 回调第三参 onCleanup 注册旧订阅的取消。
   * onCleanup 在 watch 重新执行（切会话）或组件卸载时自动调用——此前闭包 let 变量
   * unsubPush 在卸载时无人调 events.off，导致 WS 订阅泄漏。
   */
  watch(
    () => focusedSessionId.value,
    (sid, _old, onCleanup) => {
      if (sid) {
        unsubPush = workflowStore.subscribeWorkflowPush(sid)
        void workflowStore.loadWorkflows(sid)
        onCleanup(() => {
          unsubPush?.()
          unsubPush = null
        })
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
