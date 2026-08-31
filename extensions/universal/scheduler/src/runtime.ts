import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import type { DeliveryHandle, DeliveryMessage } from '@xyz-agent/session-delivery'

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

const logger = getLogger('scheduler')

const MAX_TASKS = 50
// 入队防重标记 TTL（合批非首条任务无终态回调，过期后放行重投；10 min >> 合批窗口）
const QUEUE_DEDUPE_TTL_MS = 10 * 60 * 1000
const RATE_LIMIT_PER_MINUTE = 6
const TICK_INTERVAL_MS = 30_000
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const HISTORY_LIMIT = 20 // 与 replayFoldEntries 的裁剪上限一致（advance 折叠 / dispatch 累积共用）
// pi ExtensionRunner 在 session 替换后访问 stale ctx 时抛出的错误文案片段。
// 兜底通道（防御纵深）：G1 模块级代际检测（isCtxStale）为主判，覆盖同模块环境内的 session
// 替换路径（newSession/fork/switchSession：extensionCache 命中，factory 重跑但模块环境共享，
// 模块级代数被新闭包递增）；本子串覆盖代际盲区——显式 reload / cwd 变化触发
// clearExtensionCache 后 jiti 重新 import 产生全新模块环境，旧闭包引用的模块级代数冻结
// 不再递增，isCtxStale 恒 false，此时除 session_shutdown teardown 主防线外只剩错误文案
// 能识别 stale。
// 注意：pi 非契约 API（Error message 非稳定接口），pi 升级需回归验证 runtime.test.ts 的
// U1 / G1-d 文案锚定用例；文案变更时此兜底失效，后果为 timer 泄漏 + 每 30s warn（不 crash）。
const STALE_CTX_MARKER = 'stale after session replacement'

export class SchedulerRuntime {
  private tasks: Map<string, ScheduledTask> = new Map()
  private backend: SchedulerBackend
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private dispatchTimestamps: number[] = []
  private onAfterTickCallback: (() => void) | null = null
  private readonly isCtxStale: (() => boolean) | undefined
  // R3-S1：同任务 dispatch 在途标记（Set<taskId>），见 dispatchTask 注释
  private readonly dispatchesInFlight = new Set<string>()
  // 入队防重标记（Map<taskId, enqueuedAt>）：非 force 任务 send 进 delivery 内核后、
  // 终态回调（handleSettled）前，nextRunAt 未推进——tick step2 会按 `now >= nextRunAt`
  // 重新置 pending，若无此标记，agent busy 的每个 tick 都会再压一份同 prompt 副本进队列
  // （合批后重复注入）。入队置位、delivered/rejected 清除；任务删除（delete/过期）同步清除。
  // TTL 兜底：合批投递时 onSettled 只带首条 dedupeKey，非首条任务收不到终态回调——
  // 标记过期后允许重投，保持 at-least-once（与旧「nextRunAt 未推进下 tick 重投」等价）。
  private readonly queuedInDeliveryAt = new Map<string, number>()
  // delivery handle（装配点注入；非 force 任务走内核队列）
  private delivery: DeliveryHandle | undefined

  /**
   * 依赖反转构造：backend 承担 appendEntry/pi.sendMessage/时间源，runtime 只持有内存态。
   * 不触碰任何 FS / session JSONL（测试可用 MockSchedulerBackend 零副作用注入）。
   *
   * isCtxStale（G1 代际检测，S9/R3-M1）：返回 true 表示本 runtime 建立时的 session 已被
   * 替换。index.ts 装配点注入（模块级代数比对，R3-M1），使 stale 分诊不依赖 pi 错误文案；
   * 缺省（不注入）恒视为非 stale——纯 runtime 单测与旧装配路径行为不变。
   */
  constructor(
    backend: SchedulerBackend,
    ctx?: Pick<ExtensionContext, 'isIdle' | 'hasPendingMessages'>,
    isCtxStale?: () => boolean,
  ) {
    this.backend = backend
    // ctx 不再存实例变量（gate 已交内核）；isCtxStale 保留用于代际检测
    void ctx
    this.isCtxStale = isCtxStale
    // 从 backend 获取 delivery handle（装配点注入）
    this.delivery = backend.getDeliveryHandle?.()
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
    if (deleted) this.queuedInDeliveryAt.delete(id)
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
    this.tickTimer = setInterval(() => {
      // G1（代际前置检查，S9）：本 runtime 所属 session 已被替换 → timer 属泄漏资源，
      // 自停退场且不进入本轮 tick（不触碰捕获的 stale ctx）。主防线是 F1（session_start
      // 停旧 timer），此处覆盖 F1 未能触达的泄漏路径——且不依赖「stale ctx 访问恰好抛错」
      // 或 pi 错误文案，代际一翻转即可静默退场。
      if (this.isCtxStale?.()) {
        this.retireStaleTimer()
        return
      }
      // F2（防御兜底）：fire-and-forget 的 tick 链路必须自带 catch——tick 内任何异常
      // （典型：session 替换后泄漏 timer 的 onAfterTick → refreshWidget 访问 stale ctx.ui 抛错）
      // 若无人接住即 unhandledRejection，直接崩掉 pi 主进程。分诊：G1 模块级代数比对为主判
      // （契约内，不受 pi 文案变更影响），STALE_CTX_MARKER 子串为兜底（覆盖 reload 产生全新
      // 模块环境后旧闭包代数冻结、isCtxStale 恒 false 的盲区）。stale 类错误说明本 runtime
      // 所属 session 已被替换，timer 属泄漏资源，自停退场；其他错误仅告警，不终止调度。
      void this.tickScheduler().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (this.isCtxStale?.() || message.includes(STALE_CTX_MARKER)) {
          this.retireStaleTimer()
        } else {
          logger.warn('tick error', { error: message })
        }
      })
    }, TICK_INTERVAL_MS)
  }

  stopScheduler(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  /**
   * stale 自停退场（G1 前置检查与 F2 catch 分诊共用）：warn 观测口径与 crash-fix 一致
   * （含 "tick stopped"，U1 断言锚定）+ stopScheduler（幂等）。timer 自停后调度由
   * session_start 重建的新一代 runtime 接管。
   */
  private retireStaleTimer(): void {
    logger.warn('tick stopped: stale extension ctx (session replaced); timer self-retired')
    this.stopScheduler()
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
        this.queuedInDeliveryAt.delete(id)
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

    // delivery flush：park 模式下内核不主动重试，由 scheduler tick 外部触发 flush
    // 让积压在队列中的消息在每个 tick 尝试投递
    this.delivery?.flush()
  }

  // ── dispatch ──

  /**
   * dispatch 单个任务。返回 true 表示真的发送了 message，false 表示 no-op
   * （task disabled / 已有同任务在途 / rate-limited / 非 force 且 busy）。
   *
   * R3-S1 in-flight 守卫：tick 为 fire-and-forget，若 tick1 的 `await backend.sendMessage`
   * 挂起超过 TICK_INTERVAL_MS（如 pi 卡死），tick2 的 step2 会再标 pending、step3 对同一
   * task 并发第二个 dispatch → 同一 prompt 双注入（force 任务绕过 isIdle gate 直接受影响）。
   * 参照 subagent-workflow resumesInFlight 模式：入口同步置位、finally 清除（覆盖 gate /
   * rate-limit / sendMessage 抛错 / 成功推进全部退出路径）；命中时 skip 本轮并 warn
   * （不 throw——tick 继续处理其他任务，本任务 pending 保留到下轮重试）。
   */
  async dispatchTask(task: ScheduledTask): Promise<boolean> {
    if (!task.enabled) return false
    if (this.dispatchesInFlight.has(task.id)) {
      logger.warn('dispatch already in flight, skipping this tick', { taskId: task.id })
      return false
    }
    this.dispatchesInFlight.add(task.id)
    try {
      return await this.dispatchTaskInner(task)
    } finally {
      this.dispatchesInFlight.delete(task.id)
    }
  }

  /**
   * dispatch 本体（dispatchTask 守卫置位后执行；runTaskNow 与 tick step3 共用入口，
   * 手动 run-now 与挂起中的 tick dispatch 并发时同样被守卫拦截）。
   * sendMessage 抛错时记录 failed 状态但不 rethrow，让 tick 继续处理其他任务。
   *
   * 持久化（append-only）：recurring 成功推进 nextRunAt → append advance（status='success' CL8）；
   * once 成功 → append delete。失败 dispatch 不 append（CL7 重试语义，transient 失败 nextRunAt 未推进）。
   */
  private async dispatchTaskInner(task: ScheduledTask): Promise<boolean> {
    // 检查速率限制
    if (!this.hasDispatchCapacity(this.backend.now())) return false

    if (task.force || !this.delivery) {
      // force 任务或无 delivery handle 时直投（绕过内核队列）
      return this.dispatchDirect(task)
    }

    // 已在内核队列中（入队后未终态且未过 TTL）——step2 会按未推进的 nextRunAt 重新置
    // pending，此处拦截防重复入队（见 queuedInDeliveryAt 字段注释）
    const queuedAt = this.queuedInDeliveryAt.get(task.id)
    if (queuedAt !== undefined && this.backend.now() - queuedAt < QUEUE_DEDUPE_TTL_MS) return false

    // 非 force 任务走 delivery 内核（park 模式：busy 入队等下次 tick flush）
    return this.dispatchViaDelivery(task)
  }

  /**
   * force 任务直投：绕过 delivery 内核队列，直接调 backend.sendMessage。
   * 无 delivery handle 时也走此路径（向后兼容）。
   */
  private async dispatchDirect(task: ScheduledTask): Promise<boolean> {
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
    return this.onDispatchSuccess(task)
  }

  /**
   * 非 force 任务走 delivery 内核：入队后由内核 flush 时投递。
   * gate（isIdle/hasPendingMessages）由内核管理，busy 时入队不重试（park 模式）。
   * onSettled 回调处理成功/失败记账。
   * 返回 true 表示已入队（非实际发送）。
   */
  private dispatchViaDelivery(task: ScheduledTask): boolean {
    const delivery = this.delivery!

    delivery.send({
      payload: {
        kind: 'custom',
        customType: 'pi-scheduler:dispatched',
        content: task.prompt,
        display: true,
      },
      intent: 'after-run',
      // #11：task.id 作为 onSettled 反查键（本 handle 未开 dedupe，dedupeKey 不驱动
      // 去重，仅随消息透传给 onSettled 回调）。content 反查在同 prompt 多任务下错配。
      dedupeKey: task.id,
    })

    // send() 不 throw（park 模式下入队即返回）。
    // 入队即挂防重标记 + 计入速率限制（nextRunAt 要等 delivered 后才推进，期间 step2
    // 会持续重标 pending——防重标记拦截重复入队，速率记账覆盖入队侧消耗）。
    // 成功/失败记账由 onSettled 回调异步处理。
    this.queuedInDeliveryAt.set(task.id, this.backend.now())
    this.dispatchTimestamps.push(this.backend.now())
    task.pending = false
    return true
  }

  /**
   * dispatch 成功后的状态更新与持久化（dispatchDirect 成功后、onSettled delivered 后共用）。
   * countRate=false 时不再计速率（delivery 路径入队时已计入，delivered 再计会双算）。
   */
  private async onDispatchSuccess(task: ScheduledTask, countRate = true): Promise<boolean> {
    const now = this.backend.now()
    task.runCount++
    task.lastRunAt = now
    task.lastStatus = 'success'
    task.pending = false
    task.lastError = undefined
    task.history.push({ at: now, status: 'success' })
    if (task.history.length > HISTORY_LIMIT) task.history.shift()

    if (task.kind === 'once') {
      this.tasks.delete(task.id)
      this.appendEntrySafe({ op: 'delete', taskId: task.id })
    } else {
      const next = await computeNextRunAt(task.schedule, now)
      if (next === undefined) {
        task.enabled = false
        task.lastStatus = 'failed'
        task.lastError = 'cron expression invalid'
      } else {
        task.nextRunAt = next
        this.appendEntrySafe({
          op: 'advance',
          taskId: task.id,
          nextRunAt: next,
          at: now,
          status: 'success',
        })
      }
    }

    if (countRate) this.dispatchTimestamps.push(now)
    return true
  }

  /**
   * onSettled 回调入口（index.ts 装配点绑定）：delivery 内核投递终态时调用。
   * delivered → 成功记账（onDispatchSuccess）；rejected → 失败记账。
   * once 任务失败不删持久化（at-least-once 语义）。
   * #11：按 msg.dedupeKey（dispatch 时挂的 task.id，见 dispatchViaDelivery）精确反查
   * tasks Map——旧 content 反查在「同 prompt 多任务」下错配（find 取首个命中），
   * 任务已删除时静默丢弃不误记。反查未命中（once 成功已删 / 批量合投非首条 /
   * 非 scheduler 消息）直接返回。
   * 已知限制：内核 busy 期间多条消息合投为一批时（doSend splice 全队列），onSettled
   * 只收到保留首条 dedupeKey 的 composed 消息——非首条任务不记账，靠下个 tick 的
   * nextRunAt 未推进重投（at-least-once 兜底），与旧 content 反查行为等价不劣化。
   */
  handleSettled(msg: DeliveryMessage, outcome: 'delivered' | 'rejected'): void {
    const taskId = msg.dedupeKey
    // 防重标记先清（任务可能已被删除，反查未命中也要清）
    if (taskId !== undefined) this.queuedInDeliveryAt.delete(taskId)
    const task = taskId !== undefined ? this.tasks.get(taskId) : undefined
    if (!task) return // 任务已被删除（once 成功后删）或非 scheduler 发出的消息

    if (outcome === 'delivered') {
      // fire-and-forget：onDispatchSuccess 内部 catch 不 rethrow（countRate=false：入队时已计速率）
      void this.onDispatchSuccess(task, false).catch(() => {})
    } else {
      // 失败记账
      task.lastStatus = 'failed'
      task.history.push({ at: this.backend.now(), status: 'failed' })
      if (task.history.length > HISTORY_LIMIT) task.history.shift()
      // once 任务失败不删持久化（at-least-once 语义）
    }
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
   * 委托 backend.appendEntry。失败 → logger.warn + 不 rethrow（ER-APPEND-FAIL）。
   * 内存态已先行更新（at-least-once 已知恶化窗口：append 失败则该 op 丢失，resume 重放回退）。
   * 不再设 task.lastError='persist failed'（append 失败是 transient，不应污染业务态）。
   */
  private appendEntrySafe(op: SchedulerEntryOp): void {
    try {
      this.backend.appendEntry(op)
    } catch (err) {
      // best-effort 降级（ER-APPEND-FAIL）：append-only 模型下 append 失败仅丢失该 op 的持久化，
      // 内存态已先行更新、不 rethrow，业务流程继续。at-least-once 已知恶化窗口（resume 重放回退）。
      logger.warn('appendEntry failed', { error: err instanceof Error ? err.message : String(err) })
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
}
