/**
 * useSubagentListSync —— subagent 列表的响应式同步（features 层跨 store 编排）。
 *
 * 职责：封装「subagent 列表何时该刷新」的完整决策。
 * 三个触发源：
 * 1. focusedSessionId 变化（切会话）→ clearSubagents 先清空 + 重订阅推送 + 首拉 RPC
 * 2. subagents tab 激活 + focusedSessionId 变化 → loadSubagents 首拉 RPC
 * 3. runtime 主动推送 session.subagents → store subscribeSubagentPush 被动消费（替代旧 activityKey 轮询）
 *
 * 调用方：Sidebar.vue 在 onMounted 调用一次。watch 的生命周期跟随组件。
 */
import { computed, watch } from 'vue'
import { usePanelStore } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useSubagentStore } from '@/stores/subagent'

export function useSubagentListSync(): void {
  const panel = usePanelStore()
  const sidebar = useSidebarStore()
  const subagentStore = useSubagentStore()

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
   * 1. clearSubagents 清空旧数据（消除残留窗口）
   * 2. 订阅新 session 的 session.subagents 推送（旧订阅经 watch onCleanup 自动取消）
   * 3. 首拉 RPC 兜底（推送可能晚到，RPC 立即拿到当前列表）
   *
   * [W3 / W-S1] 资源泄漏修复：改用 watch 回调第三参 onCleanup 注册旧订阅的取消。
   * onCleanup 在 watch 重新执行（切会话）或组件卸载时自动调用——此前闭包 let 变量
   * unsubPush 在卸载时无人调 events.off，导致 WS 订阅泄漏。
   */
  watch(
    () => focusedSessionId.value,
    (sid, _old, onCleanup) => {
      subagentStore.clearSubagents()
      if (sid) {
        unsubPush = subagentStore.subscribeSubagentPush(sid)
        void subagentStore.loadSubagents(sid)
        onCleanup(() => {
          unsubPush?.()
          unsubPush = null
        })
      }
    },
    { immediate: true },
  )

  /**
   * subagents tab 激活时加载 subagent 列表（tab 切换的首拉）。
   * 与推送互补：推送处理「运行时实时变化」，这里处理「用户主动切到 subagents tab」。
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
