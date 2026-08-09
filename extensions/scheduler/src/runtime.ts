import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

import type { SchedulerBackend } from './backend.js'
import { autoName, generateTaskId } from './format.js'
import { computeNextRunAt, parseDuration } from './parsing.js'
import type { AddOptions, ScheduledTask, SchedulerStore, ScheduleSpec } from './types.js'

const MAX_TASKS = 50
const RATE_LIMIT_PER_MINUTE = 6
const TICK_INTERVAL_MS = 30_000
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export class SchedulerRuntime {
  private tasks: Map<string, ScheduledTask> = new Map()
  private backend: SchedulerBackend
  private ctx: Pick<ExtensionContext, 'isIdle' | 'hasPendingMessages'>
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private dispatchTimestamps: number[] = []

  /**
   * 依赖反转构造：backend 承担 FS/pi/时间源，runtime 只持有内存态。
   * 不触碰任何 FS（测试可用 MockSchedulerBackend 零副作用注入）。
   */
  constructor(
    backend: SchedulerBackend,
    ctx: Pick<ExtensionContext, 'isIdle' | 'hasPendingMessages'>,
  ) {
    this.backend = backend
    this.ctx = ctx
  }

  // ── 任务 CRUD ──

  async addTask(prompt: string, schedule: ScheduleSpec, options: AddOptions = {}): Promise<ScheduledTask> {
    if (this.tasks.size >= MAX_TASKS) {
      throw new Error(`Task limit reached (${MAX_TASKS}). Delete a task first.`)
    }

    const id = generateTaskId()
    const now = this.backend.now()
    const kind = options.kind ?? 'recurring'
    const name = options.name ?? autoName(prompt)

    let expiresAt: number | undefined
    if (options.expires === 'never') {
      expiresAt = undefined
    } else if (kind === 'recurring') {
      const expiryMs = options.expires ? (parseDuration(options.expires) ?? DEFAULT_EXPIRY_MS) : DEFAULT_EXPIRY_MS
      expiresAt = now + expiryMs
    }

    // 统一 nextRunAt 计算：interval → now + intervalMs；cron → 下次命中
    const nextRunAt = await computeNextRunAt(schedule, now)
    if (nextRunAt === undefined) {
      // 创建时校验失败报错给用户（仅 cron 可能 undefined，interval 恒有值）
      const expr = schedule.mode === 'cron' ? schedule.cronExpression : '<unknown>'
      throw new Error(`Invalid cron expression: ${expr}`)
    }

    const task: ScheduledTask = {
      id,
      name,
      prompt,
      kind,
      schedule,
      enabled: true,
      force: options.force ?? false,
      createdAt: now,
      nextRunAt,
      expiresAt,
      runCount: 0,
      history: [],
    }

    this.tasks.set(id, task)
    await this.persist()
    return task
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.nextRunAt - b.nextRunAt)
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id)
  }

  async toggleTask(id: string, enabled: boolean): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task) return false
    task.enabled = enabled
    // enable 时若 nextRunAt 已过期，重算，避免 enable 瞬间立即触发
    if (enabled && task.nextRunAt < this.backend.now()) {
      const next = await computeNextRunAt(task.schedule, this.backend.now())
      if (next === undefined) {
        // ERR-2 fallback：cron 表达式失效 → 停用任务并记录失败原因。
        // 禁止 `?? now()` 类 fallback（会使 nextRunAt=now，下个 tick 立即重算 → 死循环）
        task.enabled = false
        task.lastStatus = 'failed'
        task.lastError = 'cron expression invalid'
        // nextRunAt 保留原值（enabled=false 后 tick 不再触发）
      } else {
        task.nextRunAt = next
      }
    }
    await this.persist()
    return true
  }

  deleteTask(id: string): boolean {
    const deleted = this.tasks.delete(id)
    if (deleted) void this.persist()
    return deleted
  }

  async runTaskNow(id: string): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task) return false
    const dispatched = await this.dispatchTask(task)
    await this.persist()
    return dispatched
  }

  // ── 调度 ──

  startScheduler(): void {
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => void this.tickScheduler(), TICK_INTERVAL_MS)
  }

  stopScheduler(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  async tickScheduler(): Promise<void> {
    const now = this.backend.now()

    // 1. 过期清理
    for (const [id, task] of this.tasks) {
      if (task.expiresAt && now >= task.expiresAt) {
        this.tasks.delete(id)
      }
    }

    // 2. 标记到期
    for (const task of this.tasks.values()) {
      if (task.enabled && now >= task.nextRunAt) {
        task.pending = true
      }
    }

    // 3. dispatch pending 任务（按 nextRunAt 排序）
    const pending = [...this.tasks.values()]
      .filter(t => t.pending)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)

    for (const task of pending) {
      if (task.pending) {
        await this.dispatchTask(task)
      }
    }

    await this.persist()
  }

  // ── dispatch ──

  /**
   * dispatch 单个任务。返回 true 表示真的发送了 message，false 表示 no-op
   * （task disabled / rate-limited / 非 force 且 busy）。
   * sendMessage 抛错时记录 failed 状态但不 rethrow，让 tick 继续处理其他任务。
   */
  async dispatchTask(task: ScheduledTask): Promise<boolean> {
    if (!task.enabled) return false

    // 检查 force 或 idle
    if (!task.force) {
      if (!this.ctx.isIdle() || this.ctx.hasPendingMessages()) {
        return false // 延迟到下次 tick
      }
    }

    // 检查速率限制
    if (!this.hasDispatchCapacity(this.backend.now())) return false

    // 注入 message（await：async 错误必须被捕获，fire-and-forget 会漏）
    try {
      await this.backend.sendMessage(
        { content: task.prompt, customType: 'pi-scheduler:dispatched', display: true },
        { deliverAs: 'followUp', triggerTurn: true },
      )
    } catch {
      task.lastStatus = 'failed'
      task.pending = false
      task.history.push({ at: this.backend.now(), status: 'failed' })
      if (task.history.length > 20) task.history.shift()
      return false
    }

    // 更新状态
    task.runCount++
    task.lastRunAt = this.backend.now()
    task.lastStatus = 'success'
    task.pending = false
    task.lastError = undefined // 成功 dispatch 后清除历史错误
    task.history.push({ at: this.backend.now(), status: 'success' })
    if (task.history.length > 20) task.history.shift()

    // 计算下次执行
    if (task.kind === 'once') {
      this.tasks.delete(task.id)
    } else {
      const next = await computeNextRunAt(task.schedule, this.backend.now())
      if (next === undefined) {
        // ERR-2 fallback：cron 表达式失效 → 停用任务，避免 `?? now()` 死循环
        task.enabled = false
        task.lastStatus = 'failed'
        task.lastError = 'cron expression invalid'
        // nextRunAt 保留原值（enabled=false 后 tick 不再触发）
      } else {
        task.nextRunAt = next
      }
    }

    this.dispatchTimestamps.push(this.backend.now())
    return true
  }

  private hasDispatchCapacity(now: number): boolean {
    const oneMinuteAgo = now - 60_000
    this.dispatchTimestamps = this.dispatchTimestamps.filter(t => t > oneMinuteAgo)
    return this.dispatchTimestamps.length < RATE_LIMIT_PER_MINUTE
  }

  // ── 持久化 ──

  /** 装配点注入初始任务数组（读盘由 backend 完成，runtime 只持有内存态）。 */
  loadTasks(tasks: ScheduledTask[]): void {
    this.tasks = new Map(tasks.map(t => [t.id, t]))
  }

  /**
   * 委托 backend.persist。失败 → console.warn + 内存态不变 + 不 rethrow（ERR-6）。
   * 失败原因记入任务 lastError（R2：已有更具体错误如 cron-invalid 的不覆盖）。
   */
  private async persist(): Promise<void> {
    const store: SchedulerStore = { version: 1, tasks: Array.from(this.tasks.values()) }
    try {
      await this.backend.persist(store)
    } catch (err) {
      console.warn(`[scheduler] persist failed: ${err instanceof Error ? err.message : String(err)}`)
      for (const task of this.tasks.values()) {
        if (!task.lastError) {
          task.lastError = 'persist failed'
        }
      }
    }
  }

  /** 立即写盘（session_shutdown 用）。内部同样捕获，不打断收尾流程。 */
  async persistSync(): Promise<void> {
    const store: SchedulerStore = { version: 1, tasks: Array.from(this.tasks.values()) }
    try {
      await this.backend.persist(store, { sync: true })
    } catch (err) {
      console.warn(`[scheduler] persist failed: ${err instanceof Error ? err.message : String(err)}`)
      for (const task of this.tasks.values()) {
        if (!task.lastError) {
          task.lastError = 'persist failed'
        }
      }
    }
  }

  // ── 工具方法 ──

  getTaskCount(): number {
    return this.tasks.size
  }
}
