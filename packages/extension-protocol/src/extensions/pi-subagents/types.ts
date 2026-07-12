/** pi-subagents extension 的渲染契约子类型（subagent-trace 组件）。 */

export type SubagentStatusValue = 'running' | 'done' | 'failed' | 'cancelled' | 'crashed'

export interface EventLogEntry {
  type: 'tool_start' | 'tool_end' | 'turn_end' | 'error'
  label: string
  status?: 'running' | 'done' | 'failed'
}
