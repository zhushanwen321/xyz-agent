import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

import type { SchedulerBackend } from './backend.js'
import { autoName, generateTaskId } from './format.js'
import { computeNextRunAt, parseDuration } from './parsing.js'
import type {
  AddOptions,
  ScheduledTask,
  SchedulerEntryOp,
  ScheduleSpec,
  TaskSnapshot,
} from './types.js'

const MAX_TASKS = 50
const RATE_LIMIT_PER_MINUTE = 6
const TICK_INTERVAL_MS = 30_000
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const HISTORY_LIMIT = 20 // 与 replayFoldEntries 的裁剪上限一致（advance 折叠 / dispatch 累积共用）

export class SchedulerRuntime {
  private tasks: Map<string, ScheduledTask> = new Map()
  private backend: SchedulerBackend
  private ctx: Pick<ExtensionContext, 'isIdle' | 'hasPendingMessages'>
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private dispatchTimestamps: number[] = []
  private onAfterTickCallback: (() => void) | null = null

  /**
   * 依赖反转构造：backend 承担 appendEntry/pi.sendMessage/时间源，runtime 只持有内存态。
   * 不触碰任何 FS / session JSONL（测试可用 MockSchedulerBackend 零副作用注入）。
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
    // append-only：写 upsert op 到 owner session JSONL（ER-APPEND-FAIL catch，内存态已更新）
    this.appendEntrySafe({
      op: 'upsert',
      taskId: id,
      // getSessionFile() 在 --no-session 模式返回 undefined → '' 兜底（该模式 appendEntry 无 owner 不落盘）
      ownerSessionFile: this.backend.getSessionFile() ?? '',
      task: this.toSnapshot(task),
    })
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
    // enable 重算到未来后的新 nextRunAt；携带到 toggle op 持久化，
    // 防 resume 重放从 upsert 快照回退到旧过期 nextRunAt（P1 跨 session 持久化）
    let recalcedNext: number | undefined
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
        recalcedNext = next
        // MF-1：重算到未来后清除残留 pending。pending 是「到期待 dispatch」标记，
        // 由 busy tick 的 step2 置位（W4 跨 tick 重试保留）。nextRunAt 已推到未来则该标记过期，
        // 否则下个 tick step3 `pending && enabled` 会在重算的未来时间点之前提前 dispatch，
        // 违背上方注释「避免 enable 瞬间立即触发」承诺。
        task.pending = false
      }
    }
    // 全部 mutation 完成后 append toggle：确保 append 的 enabled 是最终值
    // （LOW4：cron-invalid 回退 enabled=false 的路径，append enabled=false 而非入参 true）
    // P1：nextRunAt 仅 enable 重算到未来时携带——持久化重算值，防 resume 重放回退到 upsert 快照的旧过期值。
    // 普通 toggle / cron 失效回退（recalcedNext=undefined）不带，重放时保持 upsert 快照值。
    this.appendEntrySafe({
      op: 'toggle',
      taskId: id,
      enabled: task.enabled,
      ...(recalcedNext !== undefined && { nextRunAt: recalcedNext }),
    })
    return true
  }

  deleteTask(id: string): boolean {
    const deleted = this.tasks.delete(id)
    if (deleted) {
      this.appendEntrySafe({ op: 'delete', taskId: id })
    }
    return deleted
  }

  async runTaskNow(id: string): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task) return false
    // gap3：持久化由 dispatchTask 成功后 append advance(recurring)/delete(once) 隐式覆盖，
    // 不在此重复 append（advance 已在 dispatchTask chokepoint）
    return await this.dispatchTask(task)
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

  /**
   * 注册 tick 后回调（W2）。index.ts 注册 refreshWidget 替代独立 widgetTimer——
   * 每次 tickScheduler 末尾调用，对齐 TICK_INTERVAL_MS 刷新 widget。
   */
  onAfterTick(callback: () => void): void {
    this.onAfterTickCallback = callback
  }

  async tickScheduler(): Promise<void> {
    const now = this.backend.now()

    // 1. 过期清理（must-fix 2 / CL9：append delete 抵消残留 upsert，防 resume 复活已过期任务）
    // append-only 下 upsert entry 永久残留 JSONL（D10 不裁剪），若无 delete entry 抵消，
    // resume 时 replayFoldEntries 会从 upsert 重放出已过期任务 → 每 resume 复活直到首个 tick。
    for (const [id, task] of this.tasks) {
      if (task.expiresAt && now >= task.expiresAt) {
        this.tasks.delete(id)
        this.appendEntrySafe({ op: 'delete', taskId: id })
      }
    }

    // 2. 标记到期（pending 是运行时标记，与 enabled 正交）
    for (const task of this.tasks.values()) {
      if (task.enabled && now >= task.nextRunAt) {
        task.pending = true
      }
    }

    // 3. dispatch pending 任务（按 nextRunAt 排序）。W4：显式 +t.enabled，
    // 防御标记后到 dispatch 之间被 toggle disabled 的竞态（pending 与 enabled 正交）
    const pending = [...this.tasks.values()]
      .filter(t => t.pending && t.enabled)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)

    for (const task of pending) {
      if (task.pending) {
        await this.dispatchTask(task)
      }
    }

    // W2：tick 完成后刷新 widget（index.ts 注册 refreshWidget）
    this.onAfterTickCallback?.()
  }

  // ── dispatch ──

  /**
   * dispatch 单个任务。返回 true 表示真的发送了 message，false 表示 no-op
   * （task disabled / rate-limited / 非 force 且 busy）。
   * sendMessage 抛错时记录 failed 状态但不 rethrow，让 tick 继续处理其他任务。
   *
   * 持久化（append-only）：recurring 成功推进 nextRunAt → append advance（status='success' CL8）；
   * once 成功 → append delete。失败 dispatch 不 append（CL7 重试语义，transient 失败 nextRunAt 未推进）。
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
      if (task.history.length > HISTORY_LIMIT) task.history.shift()
      return false
    }

    // 更新状态（收敛到一个 now 值，避免多次 backend.now() 在真实时钟下漂移）
    const now = this.backend.now()
    task.runCount++
    task.lastRunAt = now
    task.lastStatus = 'success'
    task.pending = false
    task.lastError = undefined // 成功 dispatch 后清除历史错误
    task.history.push({ at: now, status: 'success' })
    if (task.history.length > HISTORY_LIMIT) task.history.shift()

    // 计算下次执行 + 持久化（append-only）
    if (task.kind === 'once') {
      this.tasks.delete(task.id)
      // once 成功 → append delete（CL7：抵消 upsert，防 resume 复活已执行的 once 任务）
      this.appendEntrySafe({ op: 'delete', taskId: task.id })
    } else {
      const next = await computeNextRunAt(task.schedule, now)
      if (next === undefined) {
        // ERR-2 fallback：cron 表达式失效 → 停用任务，避免 `?? now()` 死循环。
        // 不 append advance（nextRunAt 未推进，CL7 重试语义）；cron 失效停用的 enabled=false
        // 持久化缺口属 at-least-once 已知窗口（首个 tick 会再停用），非 must-fix
        task.enabled = false
        task.lastStatus = 'failed'
        task.lastError = 'cron expression invalid'
        // nextRunAt 保留原值（enabled=false 后 tick 不再触发）
      } else {
        task.nextRunAt = next
        // recurring 成功推进 nextRunAt → append advance（D1 核心：持久化新 nextRunAt，防 resume 回退重放）
        this.appendEntrySafe({
          op: 'advance',
          taskId: task.id,
          nextRunAt: next,
          at: now,
          status: 'success', // CL8：对齐 TaskStatus，非 'ok'
        })
      }
    }

    this.dispatchTimestamps.push(now)
    return true
  }

  private hasDispatchCapacity(now: number): boolean {
    const oneMinuteAgo = now - 60_000
    this.dispatchTimestamps = this.dispatchTimestamps.filter(t => t > oneMinuteAgo)
    return this.dispatchTimestamps.length < RATE_LIMIT_PER_MINUTE
  }

  // ── 装配与回调 ──

  /** 装配点注入初始任务数组（读盘/重放由 backend 完成，runtime 只持有内存态）。 */
  loadTasks(tasks: ScheduledTask[]): void {
    this.tasks = new Map(tasks.map(t => [t.id, t]))
  }

  // ── append-only 持久化辅助 ──

  /**
   * 委托 backend.appendEntry。失败 → console.warn + 不 rethrow（ER-APPEND-FAIL）。
   * 内存态已先行更新（at-least-once 已知恶化窗口：append 失败则该 op 丢失，resume 重放回退）。
   * 不再设 task.lastError='persist failed'（append 失败是 transient，不应污染业务态）。
   */
  private appendEntrySafe(op: SchedulerEntryOp): void {
    try {
      this.backend.appendEntry(op)
    } catch (err) {
      // best-effort 降级（ER-APPEND-FAIL）：append-only 模型下 append 失败仅丢失该 op 的持久化，
      // 内存态已先行更新、不 rethrow，业务流程继续。at-least-once 已知恶化窗口（resume 重放回退）。
      console.warn(
        `[scheduler] appendEntry failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * ScheduledTask → TaskSnapshot：剥离 ownerSessionFile（在 op 顶层）与 pending（运行时标记），
   * history 深拷贝（避免快照与运行时 task 共享数组引用）。
   */
  private toSnapshot(task: ScheduledTask): TaskSnapshot {
    const { ownerSessionFile: _o, pending: _p, history, ...rest } = task
    return { ...rest, history: history.slice() }
  }

  // ── 工具方法 ──

  getTaskCount(): number {
    return this.tasks.size
  }
}
