/** pi-todo extension 的渲染契约子类型（task-list 组件）。 */

export interface TaskItem {
  id: string | number
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}
export type TaskStatus = TaskItem['status']
