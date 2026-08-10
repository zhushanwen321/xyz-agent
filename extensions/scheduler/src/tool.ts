import { Static, Type } from 'typebox'

import type { SchedulerService, ServiceResult } from './service.js'

// TODO: add renderResult/renderCall to registerTool calls (standards.md §4.3)

// ── schedule tool ──

export const ScheduleParams = Type.Object({
  prompt: Type.String({ description: 'Message to inject when the task fires.' }),
  schedule: Type.String({ description: 'Schedule spec: duration (5m/2h/1d) for interval, or cron expression (*/10 * * * *).' }),
  kind: Type.Optional(Type.Union([Type.Literal('once'), Type.Literal('recurring')], { description: 'Task kind. Default: recurring.' })),
  name: Type.Optional(Type.String({ description: 'Human-readable task name. Auto-generated from prompt if omitted.' })),
  expires: Type.Optional(Type.String({ description: 'Expiry duration (30m/2h/7d). Default: 7d. Pass "never" to disable.' })),
  force: Type.Optional(Type.Boolean({ description: 'Dispatch even when agent is busy. Default: false.' })),
})

export type ScheduleParamsT = Static<typeof ScheduleParams>

export const scheduleGuidelines = [
  'This tool creates a scheduled task.',
  'Schedule accepts duration (5m, 2h, 1d) for interval-based or cron expression for time-based.',
  'Default kind is recurring. Set kind="once" for one-time reminders.',
  'After creation, the response includes task id and next 5 run times.',
  'Default expiry is 7 days. Use expires="never" for long-term tasks.',
]

/**
 * schedule tool handler（SchedulerService 瘦壳，无独立业务逻辑）。
 * 业务失败 → 结构化 isError result（不 throw）；service 未初始化等初始化异常
 * 不在此 catch——穿透到 index.ts execute 的 catch 兜底（R3）。
 */
export function createScheduleHandler(service: SchedulerService) {
  return async (params: ScheduleParamsT) => {
    const { prompt, schedule: scheduleInput, kind, name, expires, force } = params
    const result = await service.create(prompt, scheduleInput, { kind, name, expires, force })
    return toToolResult(result)
  }
}

// ── schedule_control tool ──

export const ScheduleControlParams = Type.Object({
  action: Type.Union([Type.Literal('list'), Type.Literal('toggle'), Type.Literal('delete'), Type.Literal('run')], { description: 'Action to perform.' }),
  id: Type.Optional(Type.String({ description: 'Task id. Required for toggle/delete/run.' })),
  enabled: Type.Optional(Type.Boolean({ description: 'Target enabled state. Required for toggle.' })),
})

export type ScheduleControlParamsT = Static<typeof ScheduleControlParams>

export const controlGuidelines = [
  'Use action="list" to see all scheduled tasks.',
  'After listing, use the returned id for toggle/delete/run.',
  'Prefer toggle(enabled=false) over delete for temporary pauses.',
  'action="run" fires the task immediately.',
]

export function createScheduleControlHandler(service: SchedulerService) {
  return async (params: ScheduleControlParamsT) => {
    const { action, id, enabled } = params

    let result: ServiceResult
    switch (action) {
      case 'list':
        result = service.list()
        break
      case 'toggle':
        result = await service.toggle(id, enabled)
        break
      case 'delete':
        result = service.delete(id)
        break
      case 'run':
        result = await service.run(id)
        break
      default:
        result = {
          success: false,
          errorCode: 'INVALID_PARAMS',
          message: `Unknown action: ${action}`,
        }
    }
    return toToolResult(result)
  }
}

/**
 * ServiceResult → tool execute 返回。
 * 成功 → {content: [message], details: data}；失败 → isError + details.errorCode。
 */
function toToolResult(result: ServiceResult): {
  content: { type: 'text'; text: string }[]
  details: unknown
  isError?: boolean
} {
  if (!result.success) {
    return {
      content: [{ type: 'text' as const, text: result.message }],
      details: { errorCode: result.errorCode },
      isError: true,
    }
  }
  return {
    content: [{ type: 'text' as const, text: result.message }],
    details: result.data ?? {},
  }
}
