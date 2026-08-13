import type { ScheduledTask, SchedulerEntryOp, TaskSnapshot } from './types.js'

/**
 * CustomEntry 的最小可识别形状（duck-typed，不依赖 @earendil-works/pi-coding-agent 的
 * 具体 SessionEntry 类型）。与 pending-notifications/state.ts、goal/ports.ts 同款：
 * 纯函数可独立单测，调用方传入真实 SessionEntry[] 时按结构兼容。
 */
export interface SchedulerEntryLike {
  type: string
  customType?: string
  data?: unknown
}

const HISTORY_LIMIT = 20

/**
 * 从 CustomEntry 序列折叠恢复 per-task 末态（event sourcing）。
 *
 * session_start 重放入口：PiSchedulerBackend.loadTasks() 委托本函数，把当前 session 的
 * pi-scheduler:task custom entries 折叠成运行时任务 Map。
 *
 * 两步：
 * ① 全量折叠——遍历 customType==='pi-scheduler:task' 的 entries，按 op 类型折叠：
 *    - upsert → 用快照重建任务（ownerSessionFile 来自 op 顶层）
 *    - advance → nextRunAt=新值 / lastRunAt=at / runCount++ / history.push(裁20) / lastStatus=status（gap2）
 *    - toggle → enabled=新值
 *    - delete → 从 Map 移除（后续同 taskId 的 advance/toggle 对不存在 taskId 为 no-op，安全）
 *   advance/toggle/delete 对不存在的 taskId 为 no-op，因此 fork 继承的完整序列必须先全量折叠，
 *   不能在处理 upsert 时按 owner 跳过（否则后续无 owner 字段的 op 会作用于「不存在的 taskId」丢失）。
 * ② 折叠完成后按 task.ownerSessionFile !== currentSessionFile 整体过滤（gap1）：移除 fork
 *   继承的非 owner 任务——fork 出的 session B 继承了 owner=A 的 upsert+advance 序列，但 B
 *   不应拥有 A 的任务，重放后整体过滤掉。
 *
 * append-only 时序保证 nextRunAt 不回退（D1）：advance entry 按写入顺序折叠，自然取到最后推进值。
 *
 * getEntries 解析/迭代异常 → console.warn + 返回空 Map（gap4）：降级为无任务而非崩溃 session_start。
 */
export function replayFoldEntries(
  entries: Iterable<SchedulerEntryLike>,
  currentSessionFile: string | undefined,
): Map<string, ScheduledTask> {
  try {
    const tasks = new Map<string, ScheduledTask>()

    for (const entry of entries) {
      if (entry.type !== 'custom' || entry.customType !== 'pi-scheduler:task') continue
      if (!isSchedulerEntryOp(entry.data)) continue
      const op = entry.data // SchedulerEntryOp（守卫 isSchedulerEntryOp 收窄）

      switch (op.op) {
        case 'upsert': {
          tasks.set(op.taskId, { ...snapshotToTask(op.task), ownerSessionFile: op.ownerSessionFile })
          break
        }
        case 'advance': {
          const task = tasks.get(op.taskId)
          if (!task) break // no-op for unknown taskId（fork 场景安全）
          task.nextRunAt = op.nextRunAt
          task.lastRunAt = op.at
          task.runCount += 1
          task.history.push({ at: op.at, status: op.status })
          if (task.history.length > HISTORY_LIMIT) task.history.shift()
          task.lastStatus = op.status // gap2：advance 必须恢复 lastStatus（不只 nextRunAt/lastRunAt/runCount/history）
          break
        }
        case 'toggle': {
          const task = tasks.get(op.taskId)
          if (!task) break
          task.enabled = op.enabled
          // P1：enable 重算到未来的 nextRunAt 随 toggle op 持久化；重放时应用，
          // 防 upsert 快照回退到旧过期值导致首个 tick 立即触发
          if (op.nextRunAt !== undefined) task.nextRunAt = op.nextRunAt
          break
        }
        case 'delete': {
          tasks.delete(op.taskId)
          break
        }
      }
    }

    // 步骤② fork owner 过滤（gap1）：折叠完成后整体移除非 owner 任务。
    // currentSessionFile 为 undefined（--no-session 模式）时，所有带 ownerSessionFile 的任务都被移除
    // （无 session 文件可归属，等同空 session）——该模式下 addTask 用 '' 兜底 owner，此处比较仍一致。
    for (const [id, task] of tasks) {
      if (task.ownerSessionFile !== currentSessionFile) {
        tasks.delete(id)
      }
    }

    return tasks
  } catch (err) {
    // gap4：session JSONL 损坏 / 迭代器抛错时降级为无任务，不让 session_start 崩溃。
    console.warn(
      `[scheduler] replayFoldEntries failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return new Map()
  }
}

/**
 * 类型守卫：判断 entry.data 是否为合法 SchedulerEntryOp（op 字段为 4 种合法值之一）。
 * 替代 `as { op?: unknown }` 结构断言（taste/no-unsafe-cast）：守卫函数内做真实校验，
 * Record<'op', unknown> 含必填字段、配合 typeof 校验，不是「无校验断言」。
 */
function isSchedulerEntryOp(data: unknown): data is SchedulerEntryOp {
  if (!data || typeof data !== 'object') return false
  if (!('op' in data)) return false
  const op = (data as Record<'op', unknown>).op
  return (
    typeof op === 'string' &&
    (op === 'upsert' || op === 'advance' || op === 'toggle' || op === 'delete')
  )
}

/**
 * 从 TaskSnapshot 重建 ScheduledTask（剥离 pending——运行时标记不持久化）。
 * history 深拷贝：避免快照与运行时 task 共享同一数组引用（upsert 后 task 继续被 mutate）。
 */
function snapshotToTask(snapshot: TaskSnapshot): ScheduledTask {
  return {
    id: snapshot.id,
    name: snapshot.name,
    prompt: snapshot.prompt,
    kind: snapshot.kind,
    schedule: snapshot.schedule,
    enabled: snapshot.enabled,
    force: snapshot.force,
    createdAt: snapshot.createdAt,
    nextRunAt: snapshot.nextRunAt,
    expiresAt: snapshot.expiresAt,
    runCount: snapshot.runCount,
    lastRunAt: snapshot.lastRunAt,
    lastStatus: snapshot.lastStatus,
    lastError: snapshot.lastError,
    history: snapshot.history.map(h => ({ ...h })),
  }
}
