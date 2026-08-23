/**
 * S5-kernel-unit-tests — 根单元聚合验收的内核冒烟名字锚（design.md §4 S5 同族：
 * 内核行为由 A* 用例全覆盖，本文件是聚合验收入口的精简冒烟，不是替代）。
 *
 * 场景取 S1 的内核半边最小复刻（真实 createDelivery + mock port）：
 * busy 入队不拒绝（sendChecked resolve = `{queued:true}` 语义）→ settled 边沿 flush →
 * 送达 + 队列清空。`cd packages/session-delivery && npx vitest run` 全绿即锚生效。
 */
import { describe, expect, it } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryIntent, DeliveryMessage, DeliveryPort } from '../src/types.js'

describe('S5-kernel-unit-tests 聚合冒烟（根单元验收锚）', () => {
  it('busy 入队 sendChecked resolve（queued 语义）→ settled 边沿 flush 送达 → 队列清空', async () => {
    const sendCalls: { msg: DeliveryMessage; intent: DeliveryIntent }[] = []
    let idle = false // busy 起步
    let settledCb: (() => void) | undefined
    const port: DeliveryPort = {
      supportedPayloads: ['text'],
      isIdle: () => idle,
      hasPendingMessages: () => false,
      send: (msg, intent) => {
        sendCalls.push({ msg, intent })
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {
          settledCb = undefined
        }
      },
    }

    const handle = createDelivery(port)
    try {
      // busy：入队不拒绝（投递入口 resolve，异步终态）
      await expect(
        handle.sendChecked({ payload: { kind: 'text', content: 'S5 smoke message' } }),
      ).resolves.toBeUndefined()
      expect(handle.depth()).toBe(1)
      expect(sendCalls).toHaveLength(0)

      // settled 边沿：idle 复核通过 → flush 送达（intent 回落默认 interrupt-at-turn-boundary）
      idle = true
      settledCb?.()
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]!.msg.payload).toEqual({ kind: 'text', content: 'S5 smoke message' })
      expect(sendCalls[0]!.intent).toBe('interrupt-at-turn-boundary')
      expect(handle.depth()).toBe(0)
    } finally {
      handle.dispose()
    }
  })
})
