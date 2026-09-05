/**
 * shared timeouts 单测（timeout-slow-flow-wallclock D2，u-y2）。
 *
 * 守护：BASH_RPC_TIMEOUT_MS 值与语义（1h 回收层有界兜底档，非任务正常路径超时）。
 * 值漂移会同时破坏 runtime 第一刀与 renderer backstop（D5 的 +margin 取值）的校准链。
 */
import { describe, it, expect } from 'vitest'
import { BASH_RPC_TIMEOUT_MS } from '../timeouts.js'

describe('BASH_RPC_TIMEOUT_MS（D2 composer bash RPC 独立常量）', () => {
  it('值 = 3_600_000（1 小时，对齐 worktree TIMEOUT_MAX=3600 先例）', () => {
    expect(BASH_RPC_TIMEOUT_MS).toBe(3_600_000)
  })

  it('量级为小时级（≥ 30min），与 compact 的分钟级常量（300s）无跨粒级共用', () => {
    // D2 的取值论证：bash 是任务级慢速流（合法耗时可达小时级），1h 是回收层有界兜底档。
    // 若未来调小到分钟级（<30min）即回到「!sleep 320 被误杀」的前科形态，必须重新过设计。
    expect(BASH_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(1_800_000)
  })
})
