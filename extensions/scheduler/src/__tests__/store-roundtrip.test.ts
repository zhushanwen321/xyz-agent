import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createStore } from '../store.js'
import type { ScheduledTask, SchedulerStore } from '../types.js'

/**
 * store load 白名单 round-trip（真实 fs）。
 *
 * 与 store.test.ts 的关系：该文件顶部 `vi.mock('node:fs')` 全模块 mock，
 * writeFileSync 不落盘、readFileSync 无真实返回，同文件内无法走真实 IO。
 * 本文件独立（m3 design-review 修正方向 2 选项 b），不 mock fs，
 * vitest.config include glob 自动收进（src/__tests__ 下全部 .test.ts）。
 *
 * 注意（修正方向 3）：store.gc() 用真实 Date.now() 过滤过期任务
 * （!t.expiresAt || t.expiresAt > now），构造数据的 expiresAt 必须用未来值，
 * 否则 persistSync 时任务被 gc 删掉、load 回来断言全红。
 */

const FUTURE_OFFSET_MS = 86_400_000 * 30 // 30 天，远大于真实时钟漂移

describe('store load 白名单 round-trip（真实 fs）', () => {
  let tmpCwd: string
  let storePath: string | null

  beforeEach(() => {
    // os.tmpdir 建临时 cwd 隔离 store 文件（getStorePath 基于 cwd 生成路径段）
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-store-'))
    storePath = null
  })

  afterEach(() => {
    // 清理真实写入的 store 目录树（~/.pi/agent/scheduler/<root>/<segments>/）
    if (storePath) {
      fs.rmSync(path.dirname(storePath), { recursive: true, force: true })
    }
    fs.rmSync(tmpCwd, { recursive: true, force: true })
  })

  it('六白名单字段（lastError/lastStatus/lastRunAt/expiresAt/force/history）精确 round-trip', () => {
    const now = Date.now()
    const future = now + FUTURE_OFFSET_MS
    const task: ScheduledTask = {
      id: 'abc12345',
      name: 'check build',
      prompt: 'check build status',
      kind: 'recurring',
      schedule: { mode: 'interval', intervalMs: 300_000 },
      enabled: true,
      force: true,
      createdAt: now,
      nextRunAt: future,
      expiresAt: future,
      runCount: 3,
      lastRunAt: now - 60_000,
      lastStatus: 'failed',
      lastError: 'cron expression invalid',
      history: [
        { at: now - 120_000, status: 'success' },
        { at: now - 60_000, status: 'failed', snippet: 'cron broke' },
      ],
    }
    const store: SchedulerStore = { version: 1, tasks: [task] }

    const s = createStore(tmpCwd)
    storePath = s.storePath
    s.persistSync(store)

    const loaded = s.load()
    expect(loaded.version).toBe(1)
    expect(loaded.tasks).toHaveLength(1)
    const t = loaded.tasks[0]!
    // 逐字段精确断言（白名单显式保留字段）
    expect(t.lastError).toBe('cron expression invalid')
    expect(t.lastStatus).toBe('failed')
    expect(t.lastRunAt).toBe(now - 60_000)
    expect(t.expiresAt).toBe(future)
    expect(t.force).toBe(true)
    expect(t.history).toEqual([
      { at: now - 120_000, status: 'success' },
      { at: now - 60_000, status: 'failed', snippet: 'cron broke' },
    ])
    // 非白名单依赖字段（id/schedule/enabled）一并核对
    expect(t.id).toBe('abc12345')
    expect(t.schedule).toEqual({ mode: 'interval', intervalMs: 300_000 })
    expect(t.enabled).toBe(true)
  })

  it('多任务 round-trip：history 多记录 + 各任务可选字段独立保留', () => {
    const now = Date.now()
    const future = now + FUTURE_OFFSET_MS
    const tasks: ScheduledTask[] = [
      {
        id: 'aabbccdd',
        name: 'task a',
        prompt: 'p a',
        kind: 'once',
        schedule: { mode: 'interval', intervalMs: 10_000 },
        enabled: true,
        force: false,
        createdAt: now,
        nextRunAt: future,
        runCount: 1,
        lastRunAt: now - 10_000,
        lastStatus: 'success',
        history: [{ at: now - 10_000, status: 'success' }],
      },
      {
        id: '11223344',
        name: 'task b',
        prompt: 'p b',
        kind: 'recurring',
        schedule: { mode: 'cron', cronExpression: '0 0 9 * * 1-5' },
        enabled: false,
        force: true,
        createdAt: now,
        nextRunAt: future,
        expiresAt: future,
        runCount: 0,
        lastError: 'persist failed',
        history: [],
      },
    ]

    const s = createStore(tmpCwd)
    storePath = s.storePath
    s.persistSync({ version: 1, tasks })

    const loaded = s.load()
    expect(loaded.tasks).toHaveLength(2)
    const a = loaded.tasks.find(t => t.id === 'aabbccdd')!
    const b = loaded.tasks.find(t => t.id === '11223344')!
    expect(a.lastStatus).toBe('success')
    expect(a.history).toEqual([{ at: now - 10_000, status: 'success' }])
    expect(a.expiresAt).toBeUndefined()
    expect(b.lastError).toBe('persist failed')
    expect(b.force).toBe(true)
    expect(b.schedule).toEqual({ mode: 'cron', cronExpression: '0 0 9 * * 1-5' })
    expect(b.history).toEqual([])
  })

  it('缺省可选字段降级为默认值（force=false / history=[] / expires 等 undefined）', () => {
    const now = Date.now()
    const task: ScheduledTask = {
      id: 'deadbeef',
      name: 'bare task',
      prompt: 'p',
      kind: 'recurring',
      schedule: { mode: 'interval', intervalMs: 60_000 },
      enabled: true,
      force: false,
      createdAt: now,
      nextRunAt: now + 60_000,
      runCount: 0,
      history: [],
    }

    const s = createStore(tmpCwd)
    storePath = s.storePath
    s.persistSync({ version: 1, tasks: [task] })

    const loaded = s.load()
    const t = loaded.tasks[0]!
    expect(t.force).toBe(false)
    expect(t.history).toEqual([])
    expect(t.expiresAt).toBeUndefined()
    expect(t.lastRunAt).toBeUndefined()
    expect(t.lastStatus).toBeUndefined()
    expect(t.lastError).toBeUndefined()
  })

  it('expiresAt 过期任务被 gc 清理（未来值任务保留）', () => {
    const now = Date.now()
    const expired = now - 60_000
    const future = now + FUTURE_OFFSET_MS
    const tasks: ScheduledTask[] = [
      {
        id: 'expired01',
        name: 'expired',
        prompt: 'p',
        kind: 'recurring',
        schedule: { mode: 'interval', intervalMs: 60_000 },
        enabled: true,
        force: false,
        createdAt: now,
        nextRunAt: expired,
        expiresAt: expired,
        runCount: 0,
        history: [],
      },
      {
        id: 'kept0001',
        name: 'kept',
        prompt: 'p',
        kind: 'recurring',
        schedule: { mode: 'interval', intervalMs: 60_000 },
        enabled: true,
        force: false,
        createdAt: now,
        nextRunAt: future,
        expiresAt: future,
        runCount: 0,
        history: [],
      },
    ]

    const s = createStore(tmpCwd)
    storePath = s.storePath
    s.persistSync({ version: 1, tasks })

    const loaded = s.load()
    expect(loaded.tasks).toHaveLength(1)
    expect(loaded.tasks[0]!.id).toBe('kept0001')
  })
})
