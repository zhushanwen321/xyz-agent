import type { TabStatus, TaskStatus } from '../types'

type AnyStatus = TabStatus | TaskStatus | 'idle'

/** 状态 → 文字颜色 + 背景 Tailwind class 映射 */
export function getStatusClasses(status: AnyStatus): string {
  switch (status) {
    case 'completed':
    case 'streaming':
      return 'text-[#22c55e] bg-[rgba(34,197,94,0.1)]'
    case 'thinking':
      return 'text-[#eab308] bg-[rgba(234,179,8,0.1)]'
    case 'tool':
      return 'text-[#f97316] bg-[rgba(249,115,22,0.1)]'
    case 'failed':
      return 'text-[#ef4444] bg-[rgba(239,68,68,0.1)]'
    case 'idle':
      return 'text-[#3b82f6] bg-[rgba(59,130,246,0.1)]'
    case 'running':
      return 'text-[#22c55e] bg-[rgba(34,197,94,0.1)]'
    case 'paused':
      return 'text-[#eab308] bg-[rgba(234,179,8,0.1)]'
    default:
      return 'text-[#71717a] bg-[rgba(113,113,122,0.1)]'
  }
}

/** 任务状态 → 左边框颜色 Tailwind class */
export function getTaskBorderColor(status: TaskStatus): string {
  switch (status) {
    case 'running': return 'border-l-blue-500'
    case 'completed': return 'border-l-green-500'
    case 'failed': return 'border-l-red-500'
    default: return 'border-l-zinc-600'
  }
}

/** 任务状态 → 文字颜色 Tailwind class */
export function getTaskStatusColor(status: TaskStatus): string {
  switch (status) {
    case 'running': return 'text-blue-400'
    case 'completed': return 'text-green-400'
    case 'failed': return 'text-red-400'
    case 'budget_exhausted': return 'text-yellow-400'
    case 'killed': return 'text-zinc-500'
    case 'paused': return 'text-yellow-500'
    default: return 'text-zinc-400'
  }
}
