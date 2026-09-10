/**
 * 空闲 pi 进程回收 reaper（docs/design/idle-pi-reclamation.md D2/D4/D6/D7，实施计划 u2）。
 *
 * 职责分两半：
 * 1. ReclaimSeat —— 回收占座原语（D6-2「全链占座」的状态载体）。reaper 判定通过后经
 *    reclaimManagedSession（session-lifecycle.ts）占座执行；ensureActive 入口发现占座
 *    命中则等待释放后走既有 restore（等待方永不抢跑）。占座区间只含有界步骤（判定 sync /
 *    detach sync / kill 硬上限 2s / 摘除 sync），释放由 reclaim 的 finally 保证。
 * 2. startIdlePiReaper —— 周期判定循环（D4：默认 5min 一拍，setInterval(...).unref()）。
 *    每拍枚举候选 session，逐个判定「空闲超阈值且七类豁免全不命中」→ 执行回收；一拍 N 个
 *    回收合并为一次 broadcast（D3 第 7 步——避免 N 次 scanner 全量读盘 + 侧栏 N 次重渲染）。
 *
 * DI 形态照抄 reap-orphan-pi.ts：全部依赖经 options 注入，不 import 具体服务、不读
 * process.env——阈值/tick/查看窗口默认值内联兜底，权威值由 u3 装配经 shared/constants
 * SSOT（XYZ_RUNTIME_PI_RECLAIM_* env 覆盖）传入 config，本模块保持单点可测（测试全 fake）。
 *
 * 为什么回收绝不在此直接杀进程：判定循环只做「信号读取 + 豁免检查 + 委托 reclaim」，
 * 进程处置语义（detach → destroy → 尾扫 → 最小摘除）全部收口在 session-lifecycle 的
 * reclaimManagedSession 七步编排——两个动作（判定/处置）分离，占座与代际校验才有唯一落点。
 */

/** 回收判定周期默认值（D4：5 分钟一拍；权威值由 u3 经 shared/constants + env 覆盖传入）。 */
// eslint-disable-next-line no-magic-numbers -- 5min tick（D4 权威值）：5*60*1000 算式比 300000 更自文档化
export const DEFAULT_REAP_TICK_MS = 5 * 60 * 1000

/** 空闲阈值默认值（D4：2 小时；被否 30min——抖动变常态 / 24h——对午饭级离开太迟）。 */
// eslint-disable-next-line no-magic-numbers -- 2h 空闲阈值（D4 权威值）：2*60*60*1000 算式自文档化
export const DEFAULT_IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000

/** 查看豁免窗口默认值（D2 #6：30 分钟内被 switch 过的 session 不回收）。 */
// eslint-disable-next-line no-magic-numbers -- 30min 查看豁免窗口（D2 #6 字面值）：30*60*1000 算式自文档化
export const DEFAULT_VIEWED_WINDOW_MS = 30 * 60 * 1000

/**
 * ensureActive 等待占座释放的单轮观测超时（D6-2：等待超 5s 仅记 ERROR 观测——占座实现
 * 有 bug 的信号，不是抢跑信号；等待方继续等待，绝不直接走 restore 抢跑）。
 */
export const RECLAIM_SEAT_WAIT_OBSERVE_MS = 5_000

/**
 * 回收占座原语（D6-2 全链占座）。
 *
 * 语义：同 sid 至多一个持有者；tryAcquire 失败 = 已有回收/等待方在途（判定方跳过该 sid）。
 * waitRelease 是**纯等待**原语：超时返回 false 供调用方记观测日志，本类不做任何销毁/抢跑
 * 动作——「等待方永不抢跑」在原语层就结构性成立（D6-2 被否方案：超时抢跑直接调
 * restoreSession 会在占座者未完成摘除时触发死亡清理汇聚点，三重冲突不可逆）。
 */
export class ReclaimSeat {
  private readonly held = new Set<string>()
  /** 等待释放的 waiter（sid → waiter 集）。release 时全部 resolve(true)，不区分先后。 */
  private readonly waiters = new Map<string, Set<SeatWaiter>>()

  /** 尝试占座。false = 已被持有（并发回收/重入），调用方跳过。 */
  tryAcquire(sessionId: string): boolean {
    if (this.held.has(sessionId)) return false
    this.held.add(sessionId)
    return true
  }

  /** 释放占座并唤醒全部等待方。幂等（未持有时 no-op）。 */
  release(sessionId: string): void {
    this.held.delete(sessionId)
    const ws = this.waiters.get(sessionId)
    if (!ws) return
    this.waiters.delete(sessionId)
    for (const w of ws) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve(true)
    }
  }

  isHeld(sessionId: string): boolean {
    return this.held.has(sessionId)
  }

  /**
   * 等待占座释放。立即返回 true（未持有）或被 release 唤醒返回 true；
   * timeoutMs 到期返回 false（观测信号——调用方必须继续等待或放弃本次操作，禁止抢跑）。
   * timeoutMs 缺省 = 无限等待（释放由 reclaim 的 finally 结构性保证，无限等是安全语义）。
   */
  waitRelease(sessionId: string, timeoutMs?: number): Promise<boolean> {
    if (!this.held.has(sessionId)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const waiter: SeatWaiter = { resolve, timer: undefined }
      if (timeoutMs !== undefined) {
        const timer = setTimeout(() => {
          // 超时：把自己从等待队列摘除后 resolve(false)。若此刻 release 恰好已跑完，
          // waiters 里已无本 sid 的队列（release 先 delete），本回调晚到时 ws 为 undefined，无害。
          const ws = this.waiters.get(sessionId)
          if (ws) {
            ws.delete(waiter)
            if (ws.size === 0) this.waiters.delete(sessionId)
          }
          resolve(false)
        }, timeoutMs)
        // 管理面 timer 不阻塞进程退出（对齐 pi-respawn.armTimer 的 unref 惯例）
        timer.unref?.()
        waiter.timer = timer
      }
      let ws = this.waiters.get(sessionId)
      if (!ws) {
        ws = new Set()
        this.waiters.set(sessionId, ws)
      }
      ws.add(waiter)
    })
  }

  /** 当前占座中的 sid（诊断/测试断言面）。 */
  heldSessionIds(): string[] {
    return Array.from(this.held)
  }
}

interface SeatWaiter {
  resolve: (released: boolean) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

// ── 判定循环 ──────────────────────────────────────────────────

/**
 * 七类豁免信号源（D2 表，逐一对应；全部窄接口注入，实现由 u3 装配绑定具体服务）。
 * 任一命中即本拍跳过该候选。不在此 import 具体服务——handoff inflight / delivery 排队
 * 等无公开访问器的信号由 u3 补访问器后接入（见实施计划 deviations）。
 */
export interface ReclaimExemptions {
  /** #1 occupancy 三维非 idle（turn ∈ dispatching/generating/settling，或 compacting，或 bash）。 */
  isOccupied(sessionId: string): boolean
  /** #2 有 running 后台任务（失败模式 B 硬约束——回收会让任务被判孤儿杀掉）。 */
  hasRunningBackgroundTasks(sessionId: string): boolean
  /** #3 有在途 relay 子进程（失败模式 C——subagent 在途）。 */
  hasInflightRelayChildren(sessionId: string): boolean
  /** #4 handoff 进行中。 */
  hasHandoffInflight(sessionId: string): boolean
  /** #5 delivery 内核有排队投递（completion-backflow 回流）。 */
  hasQueuedDeliveries(sessionId: string): boolean
  /** #6 最近被查看的时间戳；undefined = 从未被查看（不豁免，非 0——0 是合法 epoch）。 */
  getLastViewedAt(sessionId: string): number | undefined
  /** #7 restore / 回收自身进行中（restoringSessions；回收自身由 reaper 自身 seat 覆盖）。 */
  isRestoring(sessionId: string): boolean
}

export interface IdlePiReaperOptions {
  /** 与 reclaimManagedSession 共享的占座实例（判定跳过 + 占座互斥的同一状态）。 */
  seat: ReclaimSeat
  /** 七类豁免信号源（D2 表）。 */
  exemptions: ReclaimExemptions
  /** 空闲信号读取（u1a：client.lastActivityAt；undefined = 无信号，宁漏不误杀）。 */
  getClientActivity(sessionId: string): number | undefined
  /** 候选枚举（u3 装配绑 getActiveSessionIds）。 */
  listCandidateSessionIds(): string[]
  /**
   * 回收执行 = SessionService.reclaimSession → lifecycle.reclaimManagedSession 七步编排。
   * 返回 false = 占座失败/最终豁免拦截/代际校验取消（未回收）。
   */
  reclaim(sessionId: string): Promise<boolean>
  /**
   * 按拍合并广播（D3 第 7 步 broker.broadcast(config.sessions)）——一拍 N 个回收只调一次，
   * 在全部 seat 释放后执行；无回收不调。
   */
  broadcast(): void
  /** 判定周期 ms，默认 DEFAULT_REAP_TICK_MS。 */
  tickIntervalMs?: number
  /** 空闲阈值 ms，默认 DEFAULT_IDLE_THRESHOLD_MS。 */
  idleThresholdMs?: number
  /** 查看豁免窗口 ms，默认 DEFAULT_VIEWED_WINDOW_MS。 */
  viewedWindowMs?: number
  /** 时钟注入（测试 fake 空闲时长；缺省 Date.now）。 */
  now?: () => number
}

export interface IdlePiReaperHandle {
  /** 取消周期判定（shutdown / 测试收尾）。幂等。 */
  stop(): void
  /** 立即执行一拍判定（测试与未来手动触发入口；与周期 tick 共用同一实现）。 */
  runOnce(): Promise<void>
}

/**
 * 单拍跳过分布（D7 汇总日志的 skipped 字段）。「回收饿死」类问题（如维护通道污染回归）
 * 在分布里可见——某项计数长期独大即异常信号。
 */
export interface ReclaimSkipDistribution {
  /** 无空闲信号（client 不存在/未上报 lastActivityAt）——宁漏不误杀。 */
  noActivity: number
  /** 空闲时长未达阈值（含恰好等于阈值——比较语义 idleMs > threshold 才回收）。 */
  belowThreshold: number
  /** 回收占座中（reclaim 在途或等待方视角的其他互斥）。 */
  seatHeld: number
  /** 豁免 #1 occupancy 非空闲。 */
  occupied: number
  /** 豁免 #2 running 后台任务。 */
  backgroundTasks: number
  /** 豁免 #3 在途 relay 子进程。 */
  relayChildren: number
  /** 豁免 #4 handoff 进行中。 */
  handoff: number
  /** 豁免 #5 delivery 排队投递。 */
  queuedDeliveries: number
  /** 豁免 #6 查看窗口内被查看过。 */
  recentlyViewed: number
  /** 豁免 #7 restore 进行中。 */
  restoring: number
  /** reclaim 执行失败（编排内异常，单 session 失败不中断一拍）。 */
  reclaimFailed: number
}

function emptyDistribution(): ReclaimSkipDistribution {
  return {
    noActivity: 0, belowThreshold: 0, seatHeld: 0, occupied: 0, backgroundTasks: 0,
    relayChildren: 0, handoff: 0, queuedDeliveries: 0, recentlyViewed: 0, restoring: 0,
    reclaimFailed: 0,
  }
}

/**
 * 启动周期判定循环。timer unref（管理面不阻塞进程退出，对齐 BackgroundTaskService.start
 * / pi-respawn.armTimer 惯例）；单拍重入保护（大量候选 × kill 2s 极端下拍时长可能超周期，
 * 重入只是无害重复判定，但 inProgress flag 让语义干净）。
 */
export function startIdlePiReaper(options: IdlePiReaperOptions): IdlePiReaperHandle {
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_REAP_TICK_MS
  let stopped = false
  let inProgress = false
  const timer = setInterval(() => {
    void runOnce()
  }, tickIntervalMs)
  // unref：管理面 timer 不阻塞进程自然退出
  timer.unref?.()

  async function runOnce(): Promise<void> {
    if (stopped || inProgress) return
    inProgress = true
    try {
      await reapTick(options)
    } finally {
      inProgress = false
    }
  }

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runOnce,
  }
}

/** 执行一拍：枚举 → 逐个判定 → 回收 → 合并广播 → 汇总日志。单 session 失败不中断一拍。 */
async function reapTick(options: IdlePiReaperOptions): Promise<void> {
  const idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS
  const viewedWindowMs = options.viewedWindowMs ?? DEFAULT_VIEWED_WINDOW_MS
  const now = options.now ?? Date.now
  const { seat, exemptions } = options

  const candidates = options.listCandidateSessionIds()
  const dist = emptyDistribution()
  const reclaimed: string[] = []

  for (const sid of candidates) {
    // 豁免 #7 后半（回收自身占座）：占座中的 session 跳过——reclaim 在途，重复进入会被
    // tryAcquire 拒绝，提前跳过省一次函数调用且让分布计数完整。
    if (seat.isHeld(sid)) {
      dist.seatHeld++
      continue
    }
    // 空闲信号读取：undefined = 无 client 或 client 未上报——无信号不回收（宁漏不误杀，
    // 与孤儿收殓「ppid 判据缺失即跳过」同方向的保守取舍）。
    const activity = options.getClientActivity(sid)
    if (activity === undefined) {
      dist.noActivity++
      continue
    }
    // 阈值判定（比较语义注释）：idleMs 严格大于阈值才回收——恰好等于阈值不回收（边界值
    // 一律往「不回收」方向偏，与查看窗口 ≤ 的保守方向一致，避免时钟毛刺触发边界回收）。
    const idleMs = now() - activity
    if (idleMs <= idleThresholdMs) {
      dist.belowThreshold++
      continue
    }
    // 七类豁免（D2 表序，任一命中即跳过；短路求值——顺序即日志分布的可归因顺序）
    if (exemptions.isOccupied(sid)) {
      dist.occupied++
      continue
    }
    if (exemptions.hasRunningBackgroundTasks(sid)) {
      dist.backgroundTasks++
      continue
    }
    if (exemptions.hasInflightRelayChildren(sid)) {
      dist.relayChildren++
      continue
    }
    if (exemptions.hasHandoffInflight(sid)) {
      dist.handoff++
      continue
    }
    if (exemptions.hasQueuedDeliveries(sid)) {
      dist.queuedDeliveries++
      continue
    }
    // 豁免 #6（D2 #6 字面「≤ 30 分钟」）：elapsed === viewedWindowMs 恰在窗口边界 → 豁免。
    const viewedAt = exemptions.getLastViewedAt(sid)
    if (viewedAt !== undefined && now() - viewedAt <= viewedWindowMs) {
      dist.recentlyViewed++
      continue
    }
    if (exemptions.isRestoring(sid)) {
      dist.restoring++
      continue
    }
    // 回收执行（七步编排；返回 false = 最终豁免拦截/代际校验取消，未回收）
    try {
      const ok = await options.reclaim(sid)
      if (ok) {
        reclaimed.push(sid)
        // 每次回收一行结构化日志（D7）：sid / 空闲时长 / runtime RSS 水位。pi 进程自身
        // RSS 不经 RPC 暴露（IPiEngine 无该信号），此处的 memoryUsage 是 runtime 进程
        // 水位（与每拍汇总同源）——归因到「回收时刻」的系统内存背景。
        const mem = process.memoryUsage()
        // eslint-disable-next-line no-magic-numbers -- 1024*1024 = bytes→MB 换算，惯例自明
        console.log(`[pi-reaper] reclaimed sid=${sid} idleMs=${idleMs} runtimeRssMB=${Math.round(mem.rss / (1024 * 1024))}`)
      } else {
        dist.reclaimFailed++
      }
    } catch (e) {
      dist.reclaimFailed++
      console.error(`[pi-reaper] reclaim failed sid=${sid}:`, e instanceof Error ? e.message : e)
    }
  }

  // 按拍合并广播（D3 第 7 步）：一拍 N 个回收只广播一次，且在全部回收完成（seat 已由
  // reclaim finally 释放）之后——广播在占座外执行。
  if (reclaimed.length > 0) {
    try {
      options.broadcast()
    // eslint-disable-next-line taste/no-silent-catch -- 已 console.error 落盘（错误可观测，非静默吞错）；广播是 best-effort 通知，失败不阻断回收主流程
    } catch (e) {
      console.error('[pi-reaper] post-reclaim broadcast failed:', e instanceof Error ? e.message : e)
    }
  }

  // 每拍汇总日志（D7）：分布 + 内存水位。console.log（info 级）而非 debug——5min 一拍
  // 频率极低，prod 落盘保证「回收饿死」类异常在真实运行中可查（G4）。
  const mem = process.memoryUsage()
  console.log('[pi-reaper] tick summary', {
    action: 'idle_pi_reaper_tick',
    scanned: candidates.length,
    reclaimed,
    skipped: dist,
    thresholdMs: idleThresholdMs,
    viewedWindowMs,
    memory: {
      // eslint-disable-next-line no-magic-numbers -- 1024*1024 = bytes→MB 换算，惯例自明
      rssMB: Math.round(mem.rss / (1024 * 1024)),
      // eslint-disable-next-line no-magic-numbers -- 1024*1024 = bytes→MB 换算，惯例自明
      heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
    },
  })
}
