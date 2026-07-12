/** pi-goal extension 的渲染契约子类型（goal-status 组件）。 */

export type GoalStatusValue =
  | 'active' | 'paused' | 'blocked'
  | 'complete' | 'budget_limited' | 'time_limited' | 'cancelled'

export interface MetricBar {
  label: string
  current: number
  total?: number
  unit?: string
  severity?: 'ok' | 'warn' | 'danger'
}
