/** pi-workflow extension 的渲染契约子类型（workflow-runs 组件）。 */

export interface WorkflowRunItem {
  runId: string
  name: string
  status: 'running' | 'paused' | 'done'
  reason?: 'completed' | 'failed' | 'aborted' | 'budget_limited' | 'time_limited'
  durationMs?: number
  error?: string
}
