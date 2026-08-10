import { describe, expect, it } from 'vitest'

import { MockSchedulerBackend } from '../backend.js'
import { SchedulerRuntime } from '../runtime.js'
import type { SchedulerStore } from '../types.js'

const mockCtx = { isIdle: () => true, hasPendingMessages: () => false }

describe('MockSchedulerBackend', () => {
  it('records sendMessage calls', async () => {
    const backend = new MockSchedulerBackend()
    await backend.sendMessage(
      { content: 'hi', customType: 'pi-scheduler:dispatched', display: true },
      { deliverAs: 'followUp', triggerTurn: true },
    )
    expect(backend.sentMessages).toHaveLength(1)
    expect(backend.sentMessages[0]!.msg).toEqual({
      content: 'hi',
      customType: 'pi-scheduler:dispatched',
      display: true,
    })
    expect(backend.sentMessages[0]!.opts).toEqual({ deliverAs: 'followUp', triggerTurn: true })
  })

  it('records persist calls and throws injected persistError', async () => {
    const backend = new MockSchedulerBackend()
    const store: SchedulerStore = { version: 1, tasks: [] }

    await backend.persist(store)
    expect(backend.persistedStores).toHaveLength(1)
    expect(backend.persistedStores[0]).toBe(store)

    // persistError 注入：persist 抛该错（ERR-6 语义——错误必须能传到调用栈）
    backend.persistError = new Error('disk full')
    await expect(backend.persist(store)).rejects.toThrow('disk full')
  })

  it('now() returns injected nowValue or Date.now()', () => {
    const backend = new MockSchedulerBackend()
    expect(Math.abs(backend.now() - Date.now())).toBeLessThan(1000)
    backend.nowValue = 123456
    expect(backend.now()).toBe(123456)
  })

  // ── TC2：new SchedulerRuntime(mockBackend) 可注入单测，零 FS ──

  it('TC2: SchedulerRuntime with MockSchedulerBackend constructs and dispatches via mock', async () => {
    const backend = new MockSchedulerBackend()
    // 构造不抛错（无需 cwd/pi/store mock）
    const runtime = new SchedulerRuntime(backend, mockCtx)
    const task = await runtime.addTask('probe', { mode: 'interval', intervalMs: 60000 })
    expect(task).toBeDefined()
    // addTask 的 persist 走了 mock backend（零 FS）
    expect(backend.persistedStores).toHaveLength(1)

    await runtime.dispatchTask(task)

    // dispatch 消息走 mock backend，含 task.prompt
    expect(backend.sentMessages).toHaveLength(1)
    expect(backend.sentMessages[0]!.msg.content).toBe('probe')
    expect(backend.sentMessages[0]!.msg.customType).toBe('pi-scheduler:dispatched')
  })
})
