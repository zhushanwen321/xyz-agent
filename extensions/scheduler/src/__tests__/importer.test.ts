import * as fs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getLegacyStorePath, importLegacyStore } from '../importer.js'
import type { ScheduledTask } from '../types.js'

// vi.mock 必须在 import 之前提升。mock 工厂替换 node:fs 命名空间，
// importer.ts 内 `import * as fs` 拿到的就是这 4 个 vi.fn()。
vi.mock('node:fs', () => ({
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

const cwd = '/fake/workspace'
const storePath = getLegacyStorePath(cwd)
const importedPath = storePath + '.imported'
const sessionFile = '/x/sess.json'

/** 构造合法旧 store 任务（参考 types.ts ScheduleSpec / TaskKind 默认值）。 */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'test task',
    prompt: 'do something',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60000 },
    enabled: true,
    force: false,
    createdAt: 1000,
    nextRunAt: 2000,
    runCount: 0,
    history: [],
    ...overrides,
  }
}

/** 构造带 code 属性的 ENOENT 错误（模拟 fs.renameSync 源文件不存在）。 */
function enoentError(): Error & { code: string } {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
}

describe('importLegacyStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 默认 implementation：rename 成功、existsSync false、readFileSync 空、unlink 无副作用
    vi.mocked(fs.renameSync).mockImplementation(() => {})
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readFileSync).mockReturnValue('{}')
    vi.mocked(fs.unlinkSync).mockImplementation(() => {})
    // 抑制 importer 的 console.log/warn 输出（断言用 spy）
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── TC1：rename 原子单成功 + 逐任务 append upsert + 删 .imported ──
  it('TC1: rename 成功独占 + 2 任务逐个 appendEntry upsert + 删 .imported', () => {
    const taskA = makeTask({ id: 'aaaa', name: 'A' })
    const taskB = makeTask({ id: 'bbbb', name: 'B' })
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, tasks: [taskA, taskB] }),
    )
    const appendEntry = vi.fn()

    importLegacyStore(cwd, { appendEntry }, sessionFile)

    // 1) rename 原子独占：scheduler.json → scheduler.json.imported
    expect(fs.renameSync).toHaveBeenCalledTimes(1)
    expect(fs.renameSync).toHaveBeenCalledWith(storePath, importedPath)

    // 2) appendEntry 调 2 次，customType + op 形状正确
    expect(appendEntry).toHaveBeenCalledTimes(2)
    expect(appendEntry).toHaveBeenNthCalledWith(1, 'pi-scheduler:task', {
      op: 'upsert',
      taskId: 'aaaa',
      ownerSessionFile: sessionFile,
      task: expect.objectContaining({ id: 'aaaa', name: 'A' }),
    })
    expect(appendEntry).toHaveBeenNthCalledWith(2, 'pi-scheduler:task', {
      op: 'upsert',
      taskId: 'bbbb',
      ownerSessionFile: sessionFile,
      task: expect.objectContaining({ id: 'bbbb', name: 'B' }),
    })

    // 3) task snapshot 不含 ownerSessionFile/pending（显式剥离）
    const firstOp = appendEntry.mock.calls[0]![1] as { task: Record<string, unknown> }
    expect(firstOp.task).not.toHaveProperty('ownerSessionFile')
    expect(firstOp.task).not.toHaveProperty('pending')

    // 4) unlinkSync 删 .imported
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1)
    expect(fs.unlinkSync).toHaveBeenCalledWith(importedPath)

    // 5) 进度日志（console.warn，项目 convention 禁 console.log）
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(`imported 2 legacy tasks from ${importedPath}`),
    )
  })

  // ── TC2：.imported 残留崩溃恢复幂等 ──
  it('TC2: scheduler.json 不存在(rename ENOENT) + .imported 残留 → 读 .imported 导入 + 删 .imported', () => {
    // 实现A：scheduler.json 不存在时 renameSync 抛 ENOENT → 走 handleImportedResidue
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw enoentError()
    })
    vi.mocked(fs.existsSync).mockImplementation(p => p === importedPath) // .imported 存在
    const taskA = makeTask({ id: 'cccc' })
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, tasks: [taskA] }),
    )
    const appendEntry = vi.fn()

    importLegacyStore(cwd, { appendEntry }, sessionFile)

    expect(appendEntry).toHaveBeenCalledTimes(1)
    expect(appendEntry).toHaveBeenCalledWith('pi-scheduler:task', {
      op: 'upsert',
      taskId: 'cccc',
      ownerSessionFile: sessionFile,
      task: expect.objectContaining({ id: 'cccc' }),
    })
    expect(fs.unlinkSync).toHaveBeenCalledWith(importedPath)
  })

  // ── TC3：scheduler.json 与 .imported 都不存在 → no-op ──
  it('TC3: 双不存在（rename ENOENT + .imported 不存在）→ no-op，不抛错', () => {
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw enoentError()
    })
    vi.mocked(fs.existsSync).mockReturnValue(false) // .imported 也不存在
    const appendEntry = vi.fn()

    expect(() => importLegacyStore(cwd, { appendEntry }, sessionFile)).not.toThrow()
    expect(appendEntry).toHaveBeenCalledTimes(0)
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  // ── TC4：并发单成功者——rename 抛 ENOENT + .imported 也不存在 → skip（S10 并发场景）──
  it('TC4: 并发竞争——rename 抛 ENOENT + .imported 不存在 → 幂等 skip，不抛错', () => {
    // 两进程并发：本进程 rename 时 scheduler.json 已被另一进程 rename 走 → ENOENT
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw enoentError()
    })
    vi.mocked(fs.existsSync).mockReturnValue(false) // 本进程也没看到 .imported
    const appendEntry = vi.fn()

    expect(() => importLegacyStore(cwd, { appendEntry }, sessionFile)).not.toThrow()
    expect(appendEntry).toHaveBeenCalledTimes(0) // 别人已导入，本进程 skip
  })

  // ── TC5：currentSessionFile=undefined（--no-session 模式）→ 早 return skip ──
  it('TC5: currentSessionFile=undefined → 整个 importer skip，不碰 fs', () => {
    const appendEntry = vi.fn()

    importLegacyStore(cwd, { appendEntry }, undefined)

    expect(appendEntry).toHaveBeenCalledTimes(0)
    expect(fs.renameSync).not.toHaveBeenCalled() // 早 return，不碰 fs
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  // ── TC6：JSON 损坏降级（warn 不 rethrow）──
  it('TC6: readFileSync 返回损坏 JSON → console.warn + 不 rethrow，appendEntry 0 次', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not-json{')
    const appendEntry = vi.fn()

    expect(() => importLegacyStore(cwd, { appendEntry }, sessionFile)).not.toThrow()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[scheduler] import failed'),
    )
    expect(appendEntry).toHaveBeenCalledTimes(0) // parse 失败，无 append
  })

  // ── TC7：owner 归属——upsert op.ownerSessionFile === currentSessionFile（非旧 store 路径）──
  it('TC7: op.ownerSessionFile 严格等于传入的 currentSessionFile，非 getLegacyStorePath 推导路径', () => {
    const ownSession = '/my/session.json'
    const taskA = makeTask({ id: 'dddd' })
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, tasks: [taskA] }),
    )
    const appendEntry = vi.fn()

    importLegacyStore(cwd, { appendEntry }, ownSession)

    expect(appendEntry).toHaveBeenCalledTimes(1)
    const op = appendEntry.mock.calls[0]![1] as { ownerSessionFile: string }
    expect(op.ownerSessionFile).toBe(ownSession)
    expect(op.ownerSessionFile).not.toBe(storePath)
    expect(op.ownerSessionFile).not.toBe(importedPath)
  })
})
