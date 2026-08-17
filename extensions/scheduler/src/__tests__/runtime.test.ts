import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from '../backend.js'
import { SchedulerRuntime } from '../runtime.js'

// MockSchedulerBackend 零 FS 副作用：runtime 不再触碰 store，无需 mock store.js。

const mockCtx = { isIdle: () => true, hasPendingMessages: () => false }

describe('SchedulerRuntime', () => {
  let backend: MockSchedulerBackend
  let runtime: SchedulerRuntime

  beforeEach(() => {
    vi.clearAllMocks()
    backend = new MockSchedulerBackend()
    runtime = new SchedulerRuntime(backend, mockCtx)
  })

  describe('addTask', () => {
    it('creates a new task', async () => {
      const task = await runtime.addTask('check build', { mode: 'interval', intervalMs: 60000 })
      expect(task.id).toHaveLength(8)
      expect(task.prompt).toBe('check build')
      expect(task.enabled).toBe(true)
    })

    it('throws when task limit reached', async () => {
      for (let i = 0; i < 50; i++) {
        await runtime.addTask(`task ${i}`, { mode: 'interval', intervalMs: 60000 })
      }
      await expect(runtime.addTask('one more', { mode: 'interval', intervalMs: 60000 }))
        .rejects.toThrow('Task limit reached')
    })

    it('throws for invalid cron expression at creation', async () => {
      await expect(runtime.addTask('bad cron', { mode: 'cron', cronExpression: 'invalid * *' }))
        .rejects.toThrow('Invalid cron expression: invalid * *')
    })
  })

  describe('listTasks', () => {
    it('returns tasks sorted by nextRunAt', async () => {
      await runtime.addTask('task 1', { mode: 'interval', intervalMs: 60000 })
      await runtime.addTask('task 2', { mode: 'interval', intervalMs: 30000 })
      const tasks = runtime.listTasks()
      expect(tasks).toHaveLength(2)
      // 30s interval 的 nextRunAt 早于 60s 的，应排前
      expect(tasks[0]!.nextRunAt).toBeLessThan(tasks[1]!.nextRunAt)
    })

    // 强化断言：30s 任务 nextRunAt 更小（更早），应是 listTasks()[0]
    it('orders shorter-interval task first', async () => {
      const t60 = await runtime.addTask('60s', { mode: 'interval', intervalMs: 60000 })
      const t30 = await runtime.addTask('30s', { mode: 'interval', intervalMs: 30000 })
      const tasks = runtime.listTasks()
      expect(tasks[0]!.id).toBe(t30.id)
      expect(tasks[0]!.nextRunAt).toBeLessThan(t60.nextRunAt)
    })
  })

  describe('toggleTask', () => {
    it('toggles task enabled state', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(await runtime.toggleTask(task.id, false)).toBe(true)
      expect(runtime.getTask(task.id)?.enabled).toBe(false)
    })

    it('returns false for non-existent task', async () => {
      expect(await runtime.toggleTask('nonexistent', true)).toBe(false)
    })

    it('ERR-2: enable 时 cron 失效 → 停用 + failed + lastError，不落入 ?? now() 死循环', async () => {
      const task = await runtime.addTask('test', { mode: 'cron', cronExpression: '*/10 * * * *' })
      await runtime.toggleTask(task.id, false)
      // 手动破坏 cron 表达式（模拟表达式随环境失效），并让 nextRunAt 过期触发重算
      task.schedule = { mode: 'cron', cronExpression: 'invalid * *' }
      task.nextRunAt = 0

      await runtime.toggleTask(task.id, true)

      expect(task.enabled).toBe(false)
      expect(task.lastStatus).toBe('failed')
      expect(task.lastError).toBe('cron expression invalid')
      // nextRunAt 保留原值（0），enabled=false 后 tick 不再触发
      expect(task.nextRunAt).toBe(0)
    })
  })

  describe('deleteTask', () => {
    it('deletes existing task', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(runtime.deleteTask(task.id)).toBe(true)
      expect(runtime.getTask(task.id)).toBeUndefined()
    })

    it('returns false for non-existent task', () => {
      expect(runtime.deleteTask('nonexistent')).toBe(false)
    })
  })

  describe('dispatchTask', () => {
    it('dispatches task when idle', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      await runtime.dispatchTask(task)
      expect(backend.sentMessages).toHaveLength(1)
      expect(backend.sentMessages[0]!.msg).toEqual(expect.objectContaining({ content: 'test' }))
    })

    it('skips disabled task', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      await runtime.toggleTask(task.id, false)
      await runtime.dispatchTask(task)
      expect(backend.sentMessages).toHaveLength(0)
    })

    it('skips when not idle and force is false', async () => {
      const busyCtx = { isIdle: () => false, hasPendingMessages: () => false }
      const busyBackend = new MockSchedulerBackend()
      const busyRuntime = new SchedulerRuntime(busyBackend, busyCtx)
      const task = await busyRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      await busyRuntime.dispatchTask(task)
      expect(busyBackend.sentMessages).toHaveLength(0)
    })

    it('dispatches when force is true even if busy', async () => {
      const busyCtx = { isIdle: () => false, hasPendingMessages: () => false }
      const busyBackend = new MockSchedulerBackend()
      const busyRuntime = new SchedulerRuntime(busyBackend, busyCtx)
      const task = await busyRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      await busyRuntime.dispatchTask(task)
      expect(busyBackend.sentMessages).toHaveLength(1)
    })

    // OR 组合补全：源码 `!isIdle() || hasPendingMessages()` 任一为真即跳过。
    // idle=true 但有 pending message → dispatch 应被跳过。
    it('skips when idle but has pending messages', async () => {
      const pendingCtx = { isIdle: () => true, hasPendingMessages: () => true }
      const pendingBackend = new MockSchedulerBackend()
      const pendingRuntime = new SchedulerRuntime(pendingBackend, pendingCtx)
      const task = await pendingRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      await pendingRuntime.dispatchTask(task)
      expect(pendingBackend.sentMessages).toHaveLength(0)
    })

    it('sendMessage 失败 → 记 failed 状态但不 rethrow', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      // backend.sendMessage 抛错模拟注入失败
      backend.sendMessage = async () => { throw new Error('inject failed') }
      const dispatched = await runtime.dispatchTask(task)
      expect(dispatched).toBe(false)
      expect(task.lastStatus).toBe('failed')
      expect(task.pending).toBe(false)
      expect(task.history[task.history.length - 1]!.status).toBe('failed')
    })

    it('成功 dispatch 后清除 lastError', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      task.lastError = 'cron expression invalid'
      await runtime.dispatchTask(task)
      expect(task.lastError).toBeUndefined()
    })
  })

  // ── M10b：rate-limit ──
  // dispatchTask 受 RATE_LIMIT_PER_MINUTE=6 限制。前 6 次成功（sendMessage 被调），
  // 第 7 次被 hasDispatchCapacity 拒绝（dispatchTimestamps.length 已达 6）。
  describe('rate-limit', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('rate-limits dispatch to 6 per minute', async () => {
      // force=true 保证不被 idle/busy 干扰，直接命中 rate-limit
      const tasks: Awaited<ReturnType<typeof runtime.addTask>>[] = []
      for (let i = 0; i < 7; i++) {
        tasks.push(await runtime.addTask(`task ${i}`, { mode: 'interval', intervalMs: 60000 }, { force: true }))
      }

      // 7 次 dispatch 全在同一分钟内（fake time 不前进）
      for (const task of tasks) {
        await runtime.dispatchTask(task)
      }

      // 前 6 次成功，第 7 次被限流：sendMessage 只被调 6 次
      expect(backend.sentMessages).toHaveLength(6)
    })

    it('allows dispatch again after 1 minute window slides', async () => {
      const task = await runtime.addTask('t', { mode: 'interval', intervalMs: 60000 }, { force: true })
      // 先消耗完 6 次配额
      for (let i = 0; i < 6; i++) {
        // 同一 task 反复 dispatch（interval 模式每次重算 nextRunAt，不影响 rate-limit 计数）
        await runtime.dispatchTask(task)
      }
      expect(backend.sentMessages).toHaveLength(6)

      // 时间前进 61 秒：旧 timestamp 滑出窗口，配额恢复
      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
      const dispatched = await runtime.dispatchTask(task)
      expect(dispatched).toBe(true)
      expect(backend.sentMessages).toHaveLength(7)
    })
  })

  // ── M10d：tickScheduler ──
  describe('tickScheduler', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('dispatches due interval tasks and advances nextRunAt', async () => {
      const task = await runtime.addTask('tick me', { mode: 'interval', intervalMs: 60000 })
      // 手动让任务过期（nextRunAt 设为过去）
      task.nextRunAt = Date.now() - 1000

      await runtime.tickScheduler()

      // 已 dispatch
      expect(backend.sentMessages).toHaveLength(1)
      const updated = runtime.getTask(task.id)
      expect(updated).toBeDefined()
      expect(updated!.runCount).toBe(1)
      // nextRunAt 推进到 now + intervalMs（60000ms）
      expect(updated!.nextRunAt).toBe(Date.now() + 60000)
    })

    it('removes expired tasks (expiresAt in the past)', async () => {
      const task = await runtime.addTask('expire me', { mode: 'interval', intervalMs: 60000 })
      // expiresAt 已过：tick 的第 1 步清理会删除
      task.expiresAt = Date.now() - 1000

      await runtime.tickScheduler()

      expect(runtime.getTask(task.id)).toBeUndefined()
      // 过期清理先于 dispatch，不应 dispatch
      expect(backend.sentMessages).toHaveLength(0)
    })

    it('deletes once task after dispatch', async () => {
      const task = await runtime.addTask('one-shot', { mode: 'interval', intervalMs: 60000 }, { kind: 'once' })
      task.nextRunAt = Date.now() - 1000

      await runtime.tickScheduler()

      // once 任务 dispatch 后自删
      expect(runtime.getTask(task.id)).toBeUndefined()
      expect(backend.sentMessages).toHaveLength(1)
    })

    // ── TC1：cron 失效任务不死循环 ──
    // tick1 dispatch 成功、重算 nextRunAt 失败停用；tick2/3 因 enabled=false 不再 dispatch。
    // 旧实现 `?? Date.now()` 会把 nextRunAt 设为 now → 每 tick 立即重触发 → 死循环。
    it('TC1: cron 失效任务不死循环（sendMessage 只触发 1 次）', async () => {
      const task = await runtime.addTask('tick me', { mode: 'cron', cronExpression: '*/10 * * * *' })
      // 手动把 cron 表达式改为无效（模拟表达式随环境失效），并使任务到期
      task.schedule = { mode: 'cron', cronExpression: 'invalid * *' }
      task.nextRunAt = Date.now() - 1000

      // 连跑 3 次 tick
      await runtime.tickScheduler()
      await runtime.tickScheduler()
      await runtime.tickScheduler()

      expect(backend.sentMessages).toHaveLength(1)
      const updated = runtime.getTask(task.id)
      expect(updated).toBeDefined()
      expect(updated!.enabled).toBe(false)
      expect(updated!.lastStatus).toBe('failed')
      expect(updated!.lastError).toBe('cron expression invalid')
    })

    // ── TC-W-APPEND-FAIL：appendEntry 失败捕获（ER-APPEND-FAIL）──
    it('TC-W-APPEND-FAIL: appendEntry 失败不抛、保留内存态、不污染 lastError', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      backend.appendError = new Error('pi internal')

      // addTask 内 appendEntry 抛错 → 被捕获（console.warn），不 rethrow；内存态已更新（task 仍在）
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(runtime.getTask(task.id)).toBeDefined()
      expect(task.enabled).toBe(true)
      // appendEntrySafe 不污染业务态（append 失败是 transient，不设 lastError）
      expect(task.lastError).toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()

      // tickScheduler 同样不抛：dispatch 成功后 append advance 抛错被捕获，nextRunAt 已推进（内存态正确）
      task.nextRunAt = Date.now() - 1000
      await expect(runtime.tickScheduler()).resolves.toBeUndefined()
      const updated = runtime.getTask(task.id)!
      expect(updated.enabled).toBe(true)
      expect(updated.runCount).toBe(1)
      // nextRunAt 已推进到未来（内存态正确，append 失败只丢持久化）
      expect(updated.nextRunAt).toBe(Date.now() + 60000)
      expect(updated.lastError).toBeUndefined() // 不被 append 失败污染
      warnSpy.mockRestore()
    })

    // ── TC-W-ON-AFTER-TICK：onAfterTick 回调（W2）──
    it('TC-W-ON-AFTER-TICK: onAfterTick 回调在 tick 完成后被调用 1 次', async () => {
      const spy = vi.fn()
      runtime.onAfterTick(spy)
      await runtime.tickScheduler()
      expect(spy).toHaveBeenCalledTimes(1)
    })

    // ── TC-W-ENABLED-FILTER：tickScheduler 步骤3 显式 enabled 过滤（W4）──
    it('TC-W-ENABLED-FILTER: disabled 且到期的任务不被 dispatch，enabled 到期则 dispatch', async () => {
      // disabled + 到期
      const disabled = await runtime.addTask('disabled', { mode: 'interval', intervalMs: 60000 })
      await runtime.toggleTask(disabled.id, false)
      disabled.nextRunAt = Date.now() - 1000

      // enabled + 到期（force=true 绕过 idle/busy 检查，隔离 enabled 维度）
      const enabledTask = await runtime.addTask('enabled', { mode: 'interval', intervalMs: 60000 }, { force: true })
      enabledTask.nextRunAt = Date.now() - 1000

      await runtime.tickScheduler()

      // 只 dispatch enabled（disabled 被步骤2 不标 pending + 步骤3 +t.enabled 双重过滤）
      expect(backend.sentMessages).toHaveLength(1)
      expect(backend.sentMessages[0]!.msg.content).toBe('enabled')
      // disabled 仍在、未被 dispatch、enabled=false
      const stillDisabled = runtime.getTask(disabled.id)
      expect(stillDisabled).toBeDefined()
      expect(stillDisabled!.enabled).toBe(false)
      expect(stillDisabled!.runCount).toBe(0)
    })

    // ── MF-1：toggle enable 重算 nextRunAt 到未来时清除残留 pending ──
    // 场景：busy tick 标记 pending=true（W4 跨 tick 重试）→ disable → enable 重算到未来。
    // 修复前 pending 残留 → 下个 tick step3 `pending && enabled` 在重算的未来时间点之前提前 dispatch。
    it('MF-1: enable 重算 nextRunAt 到未来时清除残留 pending，不提前 dispatch', async () => {
      // 可控 idle 状态：先 busy 模拟 dispatchTask 跳过保留 pending（W4），后切 idle 排除 busy 干扰
      let idle = false
      const controllableCtx = { isIdle: () => idle, hasPendingMessages: () => false }
      const controllableBackend = new MockSchedulerBackend()
      const rt = new SchedulerRuntime(controllableBackend, controllableCtx)

      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const task = await rt.addTask('mf1', { mode: 'interval', intervalMs: 60000 })

      // T0+61s：任务到期 + busy → step2 标 pending=true，step3 dispatchTask busy 跳过（pending 保留）
      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
      await rt.tickScheduler()
      expect(task.pending).toBe(true) // busy tick 残留 pending（W4 跨 tick 重试）
      expect(controllableBackend.sentMessages).toHaveLength(0)

      // disable → enable：enable 重算 nextRunAt 到未来（T0+61s + 60s = T0+121s）
      await rt.toggleTask(task.id, false)
      await rt.toggleTask(task.id, true)
      expect(task.pending).toBe(false) // 修复后：重算到未来清除残留 pending
      const recalcedNext = task.nextRunAt
      expect(recalcedNext).toBeGreaterThan(Date.now()) // 确认重算到了未来

      // T0+90s：在重算的未来 nextRunAt 之前 tick，切 idle 排除 busy 干扰 → 不应 dispatch
      vi.setSystemTime(new Date('2026-01-01T00:01:30Z'))
      idle = true
      await rt.tickScheduler()
      expect(controllableBackend.sentMessages).toHaveLength(0)

      // 到达重算的未来 nextRunAt 后 tick：才 dispatch
      vi.setSystemTime(new Date(recalcedNext + 1000))
      await rt.tickScheduler()
      expect(controllableBackend.sentMessages).toHaveLength(1)
    })

    // ── P1：toggle enable 重算的 nextRunAt 跨 session 重放后保持未来值 ──
    // 场景：addTask → nextRunAt 过期 → disable → enable 重算到未来（内存）→
    //   新建第二个 SchedulerRuntime + backend.loadTasks() 重放 appendedOps（模拟 resume）→
    //   重放后 nextRunAt = 重算的未来值（非 upsert 快照旧过期值）+ enabled=true + tick 不立即 dispatch。
    // 修复前：toggle op 不带 nextRunAt，重放回退到 upsert 快照旧过期值 → 首个 tick 立即 dispatch（跨 session 数据丢失）。
    it('P1: toggle enable 重算的 nextRunAt 跨 session 重放后保持未来值，不回退到旧过期值', async () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const task = await runtime.addTask('cross-session', { mode: 'interval', intervalMs: 60000 })
      const oldNextRunAt = task.nextRunAt // T0+60s（upsert 快照值）

      // T0+120s：nextRunAt(T0+60s) 已过期
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
      expect(task.nextRunAt).toBeLessThan(Date.now())

      // disable → enable：enable 重算 nextRunAt 到未来（T0+120s + 60s = T0+180s）
      await runtime.toggleTask(task.id, false)
      await runtime.toggleTask(task.id, true)
      const recalcedNext = task.nextRunAt
      expect(recalcedNext).toBeGreaterThan(Date.now()) // 内存态已重算到未来
      expect(recalcedNext).not.toBe(oldNextRunAt) // 确实重算，非旧值

      // 模拟 resume：把第一个 runtime 的 appendedOps 包装成 entries，喂给第二个 backend 重放。
      // appendedOps = [upsert(T0+60s), toggle(enabled=false), toggle(enabled=true, nextRunAt=T0+180s)]
      const replayBackend = new MockSchedulerBackend()
      replayBackend.fakeEntries = backend.appendedOps.map(op => ({
        type: 'custom',
        customType: 'pi-scheduler:task',
        data: op,
      }))
      // fakeSessionFile 默认 '/test/session.json'，与第一个 backend 一致 → owner 过滤放行
      const replayRuntime = new SchedulerRuntime(replayBackend, mockCtx)
      replayRuntime.loadTasks(replayBackend.loadTasks())

      const replayed = replayRuntime.getTask(task.id)
      expect(replayed).toBeDefined()
      expect(replayed!.enabled).toBe(true)
      // 重放后是重算的未来值（修复核心），非 upsert 快照的旧过期值
      expect(replayed!.nextRunAt).toBe(recalcedNext)
      expect(replayed!.nextRunAt).not.toBe(oldNextRunAt)

      // 再 tick 一次（now=T0+120s < 重算 nextRunAt T0+180s）：不应 dispatch。
      // 修复前此断言会失败：nextRunAt 回退到 oldNextRunAt(T0+60s) < now → 首个 tick 立即触发
      await replayRuntime.tickScheduler()
      expect(replayBackend.sentMessages).toHaveLength(0)
    })
  })

  // ── TC9：expiresAt 三态（addTask 的 expires 分支）──
  // 源码逻辑：expires==='never' → undefined；kind==='recurring' 且 expires →
  // now + parseDuration(expires)（解析失败 ?? 默认 7d）；recurring 无 expires →
  // 默认 7d；kind==='once' 不进分支 → undefined。
  // MockSchedulerBackend nowValue 固定为 1_000_000，expiresAt 精确可控。
  describe('expiresAt', () => {
    beforeEach(() => {
      backend.nowValue = 1_000_000
    })

    it("expires: 'never' → expiresAt undefined", async () => {
      const task = await runtime.addTask(
        'test',
        { mode: 'interval', intervalMs: 60000 },
        { expires: 'never' },
      )
      expect(task.expiresAt).toBeUndefined()
    })

    it('recurring + expires 30m → now + 1_800_000', async () => {
      const task = await runtime.addTask(
        'test',
        { mode: 'interval', intervalMs: 60000 },
        { expires: '30m' },
      )
      expect(task.expiresAt).toBe(2_800_000)
    })

    it('recurring + 无 expires → 默认 7d（now + 604_800_000）', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(task.expiresAt).toBe(605_800_000)
    })

    it("kind once + expires '30m' → expiresAt undefined（once 不设过期）", async () => {
      const task = await runtime.addTask(
        'test',
        { mode: 'interval', intervalMs: 60000 },
        { kind: 'once', expires: '30m' },
      )
      expect(task.expiresAt).toBeUndefined()
    })
  })

  // ── F2：tick 错误分诊（crash-fix）──
  // startScheduler 的 interval 回调对 fire-and-forget 的 tickScheduler() 加 catch：
  // stale 类错误（session 替换后泄漏 timer 访问 stale ctx）→ warn "tick stopped" + stopScheduler
  // 自停；其他错误 → warn "tick error" 继续调度。修复前 tick 内异常无人接住 →
  // unhandledRejection → pi 主进程 exit 1。
  describe('tick 错误分诊（F2）', () => {
    const TICK_INTERVAL_MS = 30_000

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    afterEach(() => {
      runtime.stopScheduler()
      vi.useRealTimers()
    })

    it('U1: stale 错误 → warn "tick stopped" + timer 自停，后续 tick 不再发生', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const nowSpy = vi.spyOn(backend, 'now')
      runtime.onAfterTick(() => {
        throw new Error('This extension ctx is stale after session replacement or reload.')
      })

      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick1：stale 抛 → catch 分诊 → 自停

      const warnText = warnSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('tick stopped')
      expect(warnText).not.toContain('tick error')

      const countAfterSelfStop = nowSpy.mock.calls.length
      expect(countAfterSelfStop).toBeGreaterThan(0) // tick1 确实跑过（排除「timer 未启动」假绿）

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2) // 60s：timer 已停，无新 tick
      expect(nowSpy.mock.calls.length).toBe(countAfterSelfStop) // now 计数不再增长
      warnSpy.mockRestore()
      nowSpy.mockRestore()
    })

    it('U2: 非 stale 错误 → warn "tick error" 且调度继续（advance 两次 now 计数 +2）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const nowSpy = vi.spyOn(backend, 'now')
      runtime.onAfterTick(() => {
        throw new Error('boom')
      })

      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS) // tick1：warn 但不停

      const warnText = warnSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('tick error')
      expect(warnText).not.toContain('tick stopped')

      const countAfterFirstTick = nowSpy.mock.calls.length
      expect(countAfterFirstTick).toBeGreaterThan(0)

      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2) // 2 个后续 tick 照常
      expect(nowSpy.mock.calls.length).toBe(countAfterFirstTick + 2)
      warnSpy.mockRestore()
      nowSpy.mockRestore()
    })

    it('U5: stopScheduler 幂等——连续调用两次不抛、无副作用', () => {
      runtime.startScheduler()
      expect(() => {
        runtime.stopScheduler()
        runtime.stopScheduler()
      }).not.toThrow()
    })
  })
})
