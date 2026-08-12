import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from '../backend.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'
import { createScheduleControlHandler, createScheduleHandler } from '../tool.js'

const mockCtx = { isIdle: () => true, hasPendingMessages: () => false }

describe('schedule tool', () => {
  let service: SchedulerService
  let handler: ReturnType<typeof createScheduleHandler>

  beforeEach(() => {
    vi.clearAllMocks()
    const backend = new MockSchedulerBackend()
    service = new SchedulerService(new SchedulerRuntime(backend, mockCtx), () => backend.now())
    handler = createScheduleHandler(service)
  })

  it('creates task with duration', async () => {
    const result = await handler({ prompt: 'check build', schedule: '5m' })
    expect(result.content[0]!.text).toContain('Task "check build"')
    const details = result.details as { task: { schedule: { mode: string; intervalMs: number } } }
    expect(details.task.schedule).toEqual({ mode: 'interval', intervalMs: 300000 })
  })

  it('invalid schedule returns isError with message (not throw)', async () => {
    const result = await handler({ prompt: 'test', schedule: 'invalid' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Invalid schedule')
    const details = result.details as { errorCode: string }
    expect(details.errorCode).toBe('INVALID_SCHEDULE')
  })
})

describe('schedule_control tool', () => {
  let service: SchedulerService
  let handler: ReturnType<typeof createScheduleControlHandler>

  beforeEach(() => {
    vi.clearAllMocks()
    const backend = new MockSchedulerBackend()
    service = new SchedulerService(new SchedulerRuntime(backend, mockCtx), () => backend.now())
    handler = createScheduleControlHandler(service)
  })

  it('lists tasks', async () => {
    await service.create('test', '5m')
    const result = await handler({ action: 'list' })
    expect(result.content[0]!.text).toContain('test')
  })

  it('returns empty message when no tasks', async () => {
    const result = await handler({ action: 'list' })
    expect(result.content[0]!.text).toBe('No scheduled tasks.')
  })

  it('toggles task', async () => {
    const created = await service.create('test', '5m')
    const result = await handler({ action: 'toggle', id: created.data!.task.id, enabled: false })
    expect(result.content[0]!.text).toContain('disabled')
  })

  it('missing id on toggle returns isError', async () => {
    const result = await handler({ action: 'toggle', enabled: true })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('id is required')
  })

  // TC5 tool 侧：toggle 不存在 id → 结构化 isError + TASK_NOT_FOUND
  it('TC5: toggle unknown id returns isError with TASK_NOT_FOUND', async () => {
    const result = await handler({ action: 'toggle', id: 'deadbeef', enabled: false })
    expect(result.isError).toBe(true)
    const details = result.details as { errorCode: string }
    expect(details.errorCode).toBe('TASK_NOT_FOUND')
    expect(result.content[0]!.text).toBe('Task deadbeef not found.')
  })

  it('deletes task', async () => {
    const created = await service.create('test', '5m')
    const result = await handler({ action: 'delete', id: created.data!.task.id })
    expect(result.content[0]!.text).toContain('deleted')
  })

  it('runs task now', async () => {
    const created = await service.create('test', '5m')
    const result = await handler({ action: 'run', id: created.data!.task.id })
    expect(result.content[0]!.text).toContain('executed')
  })
})
