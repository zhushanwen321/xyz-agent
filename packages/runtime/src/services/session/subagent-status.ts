import type { SubagentStatus } from '@xyz-agent/shared'

/**
 * 将 pi-subagent-workflow 各出口的状态字符串归一化为 SubagentStatus。
 *
 * pi 侧状态来源分散且命名不一致（bg-notify 发 done/failed/cancelled、
 * listResponse 可能给 running/done、PR #85 的 manifest 写 completed/failed、
 * 子进程崩溃重建路径推断 crashed），本函数统一收敛到 SubagentStatus 五态。
 *
 * runtime 的 event-interpreter（实时路径）与 subagent-extractor（磁盘路径）共用此函数，
 * 避免两处手写三元/switch 漂移（历史 bug：event-interpreter 的三元缺 completed/crashed 归一）。
 *
 * [2026-08-05] 自 @xyz-agent/shared 下沉（架构审计 7.1：单消费者驱动归位）——
 * 消费者仅 runtime 2 文件，shared 只保留真正跨端复用的类型/常量。
 */
export function normalizeSubagentStatus(status: string | undefined): SubagentStatus {
  if (!status) return 'running'
  switch (status) {
    case 'done':
    case 'completed':
    case 'success':
      return 'done'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'crashed':
      return 'crashed'
    case 'running':
    case 'pending':
    case 'active':
      return 'running'
    default:
      // 未知状态：pi 扩展可能新增了未映射的状态，warn 一次便于排查
      console.warn(`[normalizeSubagentStatus] unknown status: ${JSON.stringify(status)}, falling back to 'running'`)
      return 'running'
  }
}
