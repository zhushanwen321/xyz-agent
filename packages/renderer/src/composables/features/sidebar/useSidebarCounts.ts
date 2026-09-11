/**
 * useSidebarCounts —— Sidebar tab 计数（从 Sidebar.vue 提取，减行用）。
 *
 * 职责：fileTree / subagent / workflow 在当前焦点 session 下的计数 computed，
 * 供 SegmentedTab 渲染数量徽标 + SubagentList/WorkflowList 列表数据。
 *
 * 依赖 fileTreeStore / subagentStore / workflowStore / panelStore（pinia 单例 store，
 * composable 内部安全调用）。focusedSessionId 由调用方注入（来自 useSidebar）。
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { usePanelStore } from '@/stores/panel'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { subagentBucket } from '@/lib/subagent-bucket'

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
  // R3-7（H2 阶段 3 一致性审查）：列表链组装点过滤 workflow origin record——Agents tab
  // 域 = 手动派发 subagent，workflow 派发 record（origin==='workflow'）由 workflow tab/
  // run 视图承载（与上方 badge 过滤 D1② 同语义，TUI 面全量隐藏对称）。
  // 为什么落在组装点而非 filterSubagents/countSubagents（subagent-bucket SSOT）：此处一处
  // 过滤后，下游三桶（active/ended/all）、FilterBar 计数、「查看全部 (N)」自动一致；
  // 若在 SSOT 桶逻辑里过滤，active/ended 滤而 all 不滤会破 active+ended=all 自洽，
  // 全滤则需双函数联动，侵入面更大。origin 缺省（undefined = tool 语义）恒保留。
  const subagentList = computed(() =>
    subagentStore
      .recordsOf(focusedSessionId.value ?? '')
      .value.filter((r) => r.origin !== 'workflow'),
  )
  const subagentCount = computed(() => subagentList.value.length)
  // D8 口径收窄：badge 判据 =「进行中」桶 SSOT（subagentBucket === 'active'，D6 #5）——
  // 与 SubagentList/FilterBar 的 active 计数恒同源（含 done 投影排除 + waiting 计入语义），
  // 消除 badge 与列表计数口径漂移
  // H2 W1（record-unification D1②）：workflow 脚本派发的 record（origin==='workflow'）
  // 不计入 subagent badge——workflow 进度由 workflow tab/run 视图承载，混入会虚亮
  // subagent 徽标。origin 缺省（undefined = tool 语义，存量 record）恒计入。
  const subagentRunningCount = computed(
    () =>
      subagentList.value.filter((r) => r.origin !== 'workflow' && subagentBucket(r) === 'active')
        .length,
  )
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
