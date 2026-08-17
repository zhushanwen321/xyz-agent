/**
 * useSidebarCounts —— Sidebar tab 计数（从 Sidebar.vue 提取，减行用）。
 *
 * 职责：fileTree / subagent / workflow 在当前焦点 session 下的计数 computed，
 * 供 SegmentedTab 渲染数量徽标 + SubagentList/WorkflowList 列表数据。
 *
 * 依赖 fileTreeStore / subagentStore / workflowStore / panelStore（pinia 单例 store，
 * composable 内部安全调用）。focusedSessionId 由调用方注入（来自 useSidebarNew）。
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { usePanelStore } from '@/stores/panel'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'

export function useSidebarCounts(focusedSessionId: Ref<string | null>) {
  const fileTreeStore = useFileTreeStore()
  const panelStore = usePanelStore()
  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()

  /** tab 计数（fileTree / subagent / workflow） */
  const fileCount = computed(() => {
    const sid = focusedSessionId.value
    if (!sid) return 0
    return fileTreeStore.getTree(sid)?.length ?? 0
  })
  const subagentCount = computed(() => subagentStore.recordsOf(focusedSessionId.value ?? '').value.length)
  const subagentRunningCount = computed(
    () => subagentStore.recordsOf(focusedSessionId.value ?? '').value.filter((r) => r.status === 'running').length,
  )
  const subagentList = computed(() => subagentStore.recordsOf(focusedSessionId.value ?? '').value)
  const workflowCount = computed(() => workflowStore.recordsOf(focusedSessionId.value ?? '').value.length)
  const workflowRunningCount = computed(
    () =>
      workflowStore
        .recordsOf(focusedSessionId.value ?? '')
        .value.filter((r) => r.status === 'running' || r.status === 'paused').length,
  )
  const workflowList = computed(() => workflowStore.recordsOf(focusedSessionId.value ?? '').value)
  /** workflow 详情态（null 时显示列表） */
  const currentWorkflow = computed(() =>
    focusedSessionId.value ? workflowStore.getCurrentWorkflow(panelStore.activePanelId, focusedSessionId.value) : null,
  )

  return {
    fileCount,
    subagentCount,
    subagentRunningCount,
    subagentList,
    workflowCount,
    workflowRunningCount,
    workflowList,
    currentWorkflow,
  }
}
