/**
 * useSubagentListSync —— subagent 列表的响应式同步（features 层跨 store 编排）。
 *
 * 职责：封装「subagent 列表何时该刷新」的完整决策，从 Sidebar.vue 沉入此 composable。
 * 集中三处触发源：
 * 1. focusedSessionId 变化（切会话）→ clearSubagents 先清空，消除旧数据残留窗口
 * 2. subagents tab 激活 + focusedSessionId 变化 → loadSubagents 加载新 session 数据
 * 3. subagents tab 激活 + 活动签名变化（subagent tool_call / bg-notify）→ loadSubagents 实时刷新
 *
 * 调用方：Sidebar.vue 在 onMounted 调用一次。watch 的生命周期跟随组件。
 */
import { computed, watch } from 'vue'
import { usePanelStore } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useChatStore } from '@/stores/chat'
import { useSubagentStore } from '@/stores/subagent'
import { SUBAGENT_TOOL_NAMES } from '@xyz-agent/shared'

export function useSubagentListSync(): void {
  const panel = usePanelStore()
  const sidebar = useSidebarStore()
  const chat = useChatStore()
  const subagentStore = useSubagentStore()

  /**
   * 当前焦点 session（与 useSidebar.focusedSessionId 同源）。
   * panel store 的 activePanelId → sessionId 是 UI 高亮的真相源。
   */
  const focusedSessionId = computed<string | null>(
    () => panel.panels.find((p) => p.id === panel.activePanelId)?.sessionId ?? null,
  )

  /**
   * 当前焦点 session 的 subagent 活动签名。
   * 追踪两类实时事件：subagent tool_call 的出现（主 agent 发起 subagent）和
   * subagent-bg-notify 消息的到达（后台 subagent 完成/状态变更）。
   * 签名格式：`<subagentToolCallCount>:<bgNotifyCount>`，任一变化 → watch 触发列表刷新。
   */
  const subagentActivityKey = computed(() => {
    const sid = focusedSessionId.value
    if (!sid) return ''
    const msgs = chat.getMessages(sid)
    let toolCallCount = 0
    let bgNotifyCount = 0
    for (const m of msgs) {
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (SUBAGENT_TOOL_NAMES.has(tc.toolName)) toolCallCount++
        }
      }
      if (m.customType === 'subagent-bg-notify') bgNotifyCount++
    }
    return `${toolCallCount}:${bgNotifyCount}`
  })

  /**
   * 切会话时立即清空 subagent 列表（消除旧数据残留窗口）。
   * loadSubagents 是 async，在请求 in-flight 期间 records 仍是旧 session 的数据。
   * clearSubagents 先清空 → 计数归零 → 随后 loadSubagents 异步加载新数据。
   */
  watch(
    () => focusedSessionId.value,
    () => {
      subagentStore.clearSubagents()
    },
  )

  /**
   * subagents tab 激活或 session 切换时加载 subagent 列表。
   * 与实时刷新 watch 互补：那个处理「已在 subagents tab 时状态变化」，
   * 这个处理「用户主动切到 subagents tab 或切会话」。
   */
  watch(
    () => [sidebar.activeTab, focusedSessionId.value] as const,
    ([tab, sid]) => {
      if (tab === 'subagents' && sid) {
        void subagentStore.loadSubagents(sid)
      }
    },
  )

  /**
   * 实时刷新：subagents tab 激活时，主 agent 发起 subagent 或后台 subagent 完成
   * 都会改变 subagentActivityKey → 触发 loadSubagents 刷新侧边栏列表。
   */
  watch(
    [() => sidebar.activeTab, subagentActivityKey] as const,
    ([tab]) => {
      if (tab === 'subagents' && focusedSessionId.value) {
        void subagentStore.loadSubagents(focusedSessionId.value)
      }
    },
  )
}
