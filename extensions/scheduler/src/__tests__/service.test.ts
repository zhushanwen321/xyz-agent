import { beforeEach, describe, expect, it } from 'vitest'

import { MockSchedulerBackend } from '../backend.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'

const mockCtx = { isIdle: () => true, hasPendingMessages: () => false }

describe('SchedulerService', () => {
  let service: SchedulerService

  beforeEach(() => {
    service = new SchedulerService(new SchedulerRuntime(new MockSchedulerBackend(), mockCtx))
  })

  describe('create', () => {
    it('creates task with duration and returns full summary', async () => {
      const result = await service.create('check build', '5m')
      expect(result.success).toBe(true)
      expect(result.errorCode).toBeUndefined()
      expect(result.message).toContain('Task "check build"')
      expect(result.message).toContain('every 5m')
      expect(result.message).toContain('Next 5 runs:')
      expect(result.data!.task.schedule).toEqual({ mode: 'interval', intervalMs: 300000 })
      expect(result.data!.nextRuns).toHaveLength(5)
    })

    it('creates cron task', async () => {
      const result = await service.create('standup', '0 9 * * 1-5')
      expect(result.success).toBe(true)
      expect(result.data!.task.schedule).toEqual({ mode: 'cron', cronExpression: '0 0 9 * * 1-5' })
    })

    it('returns INVALID_SCHEDULE for invalid schedule', async () => {
      const result = await service.create('test', 'invalid')
      expect(result).toEqual({
        success: false,
        errorCode: 'INVALID_SCHEDULE',
        message: 'Invalid schedule: "invalid". Use duration (5m/2h/1d) or cron expression (*/10 * * * *).',
      })
    })

    it('returns TASK_LIMIT_REACHED when 50 tasks exist', async () => {
      for (let i = 0; i < 50; i++) {
        await service.create(`task ${i}`, '5m')
      }
      const result = await service.create('one more', '5m')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('TASK_LIMIT_REACHED')
      expect(result.message).toContain('Task limit reached (50)')
    })
  })

  describe('list', () => {
    it('returns empty message when no tasks', () => {
      expect(service.list()).toEqual({
        success: true,
        message: 'No scheduled tasks.',
        data: { tasks: [] },
      })
    })

    it('returns formatted lines when tasks exist', async () => {
      await service.create('check build', '5m')
      const result = service.list()
      expect(result.success).toBe(true)
      expect(result.message).toContain('check build')
      expect(result.message).toContain('every 5m')
      expect(result.data!.tasks).toHaveLength(1)
    })

    it('marks disabled tasks with ○', async () => {
      const created = await service.create('paused', '5m')
      await service.toggle(created.data!.task.id, false)
      const result = service.list()
      expect(result.message).toContain('○')
    })
  })

  describe('toggle', () => {
    it('toggles task', async () => {
      const created = await service.create('test', '5m')
      const id = created.data!.task.id
      const result = await service.toggle(id, false)
      expect(result).toEqual({ success: true, message: `Task ${id} disabled.` })
      expect(service.runtime.getTask(id)?.enabled).toBe(false)
    })

    it('TC4: returns TASK_NOT_FOUND for unknown id', async () => {
      const result = await service.toggle('deadbeef', true)
      expect(result).toEqual({
        success: false,
        errorCode: 'TASK_NOT_FOUND',
        message: 'Task deadbeef not found.',
      })
    })

    it('returns INVALID_PARAMS when id missing', async () => {
      const result = await service.toggle(undefined, true)
      expect(result).toEqual({
        success: false,
        errorCode: 'INVALID_PARAMS',
        message: 'id is required for toggle.',
      })
    })

    it('returns INVALID_PARAMS when enabled missing', async () => {
      const result = await service.toggle('abc12345', undefined)
      expect(result).toEqual({
        success: false,
        errorCode: 'INVALID_PARAMS',
        message: 'enabled is required for toggle.',
      })
    })
  })

  describe('delete', () => {
    it('deletes task', async () => {
      const created = await service.create('test', '5m')
      const id = created.data!.task.id
      const result = service.delete(id)
      expect(result).toEqual({ success: true, message: `Task ${id} deleted.` })
      expect(service.runtime.getTask(id)).toBeUndefined()
    })

    it('TC4: returns TASK_NOT_FOUND for unknown id', () => {
      const result = service.delete('deadbeef')
      expect(result).toEqual({
        success: false,
        errorCode: 'TASK_NOT_FOUND',
        message: 'Task deadbeef not found.',
      })
    })
  })

  describe('run', () => {
    it('runs task now', async () => {
      const created = await service.create('test', '5m')
      const id = created.data!.task.id
      const result = await service.run(id)
      expect(result).toEqual({ success: true, message: `Task ${id} executed.` })
      expect(service.runtime.getTask(id)?.runCount).toBe(1)
    })

    it('TC4: returns TASK_NOT_FOUND for unknown id', async () => {
      const result = await service.run('deadbeef')
      expect(result).toEqual({
        success: false,
        errorCode: 'TASK_NOT_FOUND',
        message: 'Task deadbeef not found.',
      })
    })

    it('returns DISPATCH_SKIPPED for disabled task (not not-found)', async () => {
      const created = await service.create('test', '5m')
      const id = created.data!.task.id
      await service.toggle(id, false)
      const result = await service.run(id)
      expect(result).toEqual({
        success: false,
        errorCode: 'DISPATCH_SKIPPED',
        message: `Task ${id} not dispatched (busy, disabled, or rate-limited).`,
      })
    })

    // TC8：busy 场景（任务 enabled 但 ctx.isIdle() 返回 false）→ dispatch no-op →
    // DISPATCH_SKIPPED。m2 只覆盖了 disabled 场景，busy 是 dispatchTask 的
    // `!task.force && (!ctx.isIdle() || ctx.hasPendingMessages())` 独立分支。
    it('returns DISPATCH_SKIPPED when ctx is busy (isIdle=false)', async () => {
      const busyCtx = { isIdle: () => false, hasPendingMessages: () => false }
      const busyBackend = new MockSchedulerBackend()
      const busyService = new SchedulerService(new SchedulerRuntime(busyBackend, busyCtx))

      const created = await busyService.create('test', '5m')
      const id = created.data!.task.id
      const result = await busyService.run(id)

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('DISPATCH_SKIPPED')
      expect(result.message).toContain('busy')
      // 未发送任何 message（dispatch no-op）
      expect(busyBackend.sentMessages).toHaveLength(0)
    })
  })
})
