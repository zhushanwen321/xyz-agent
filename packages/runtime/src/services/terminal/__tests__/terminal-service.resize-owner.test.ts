/**
 * TerminalService resize owner 单测（P6 D7）。
 *
 * 覆盖先到先得 owner 模型：
 * - A 持有 owner 后 B resize 被拒（ResizeLockedError）
 * - clearResizeOwner(clientId) 释放后 B resize 成功
 * - 同 owner 重复 resize 成功
 * - 无 PTY 时 resize no-op 不记录 owner
 * - destroyPty 清理 owner
 *
 * mock 策略：复用 terminal-service.test.ts 的 node-pty mock 模式（vi.hoisted）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'

const { mockPtys, createMockPty } = vi.hoisted(() => {
  interface MockPty {
    onData: (listener: (data: string) => void) => { dispose: () => void }
    onExit: (listener: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void }
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    kill: () => void
    pid: number
    __emitData: (data: string) => void
    __emitExit: (exitCode: number) => void
  }
  const mockPtys: MockPty[] = []
  function createMockPty(): MockPty {
    const dataListeners: Array<(data: string) => void> = []
    const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = []
    return {
      onData: (listener) => {
        dataListeners.push(listener)
        return { dispose: () => { const i = dataListeners.indexOf(listener); if (i >= 0) dataListeners.splice(i, 1) } }
      },
      onExit: (listener) => {
        exitListeners.push(listener)
        return { dispose: () => { const i = exitListeners.indexOf(listener); if (i >= 0) exitListeners.splice(i, 1) } }
      },
      write: () => {},
      resize: () => {},
      kill: () => {},
      pid: Math.floor(Math.random() * 100000),
      __emitData: (data: string) => { for (const l of dataListeners) l(data) },
      __emitExit: (exitCode: number) => { for (const l of exitListeners) l({ exitCode }) },
    }
  }
  return { mockPtys, createMockPty }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const pty = createMockPty()
    pty.write = vi.fn()
    pty.resize = vi.fn()
    pty.kill = vi.fn()
    mockPtys.push(pty)
    return pty
  }),
}))

import { TerminalService, ResizeLockedError } from '../terminal-service.js'

function createBroadcastCollector(): { messages: ServerMessage[]; broadcast: (m: ServerMessage) => void } {
  const messages: ServerMessage[] = []
  return {
    messages,
    broadcast: (m: ServerMessage) => { messages.push(m) },
  }
}

describe('TerminalService resize owner (P6 D7)', () => {
  beforeEach(() => {
    mockPtys.length = 0
  })

  it('TC1: A 持有 owner 后 B resize 被拒（ResizeLockedError）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s1', undefined, 80, 24)
    const pty = mockPtys.at(-1)!

    // A resize → owner=A
    svc.resize('s1', 100, 30, 'A', 'iMac')
    expect(pty.resize).toHaveBeenCalledWith(100, 30)

    // B resize 同 sid → 抛 ResizeLockedError
    expect(() => svc.resize('s1', 120, 40, 'B', 'iPad')).toThrow(ResizeLockedError)
    try {
      svc.resize('s1', 120, 40, 'B', 'iPad')
    } catch (e) {
      expect(e).toBeInstanceOf(ResizeLockedError)
      const err = e as ResizeLockedError
      expect(err.owner).toBe('A')
      expect(err.ownerDevice).toBe('iMac')
      expect(err.code).toBe('resize_locked')
    }
    // proc.resize 第二次未调（B 被拒，A 的 resize 只调一次）
    expect(pty.resize).toHaveBeenCalledTimes(1)
  })

  it('TC2: clearResizeOwner(A) 后 B resize 成功（owner 变 B）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s1', undefined, 80, 24)
    const pty = mockPtys.at(-1)!

    svc.resize('s1', 100, 30, 'A', 'iMac')
    // A 断开 → clearResizeOwner('A')
    svc.clearResizeOwner('A')
    // B resize 成功
    svc.resize('s1', 120, 40, 'B', 'iPad')
    expect(pty.resize).toHaveBeenCalledWith(120, 40)
    // 再让 C resize 验证 owner 现在是 B（C 被拒）
    expect(() => svc.resize('s1', 130, 50, 'C', 'iPhone')).toThrow(ResizeLockedError)
  })

  it('TC3: 同一 owner 重复 resize 成功（owner 不变）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s1', undefined, 80, 24)
    const pty = mockPtys.at(-1)!

    svc.resize('s1', 100, 30, 'A', 'iMac')
    svc.resize('s1', 120, 40, 'A', 'iMac') // 同 clientId，不拒
    expect(pty.resize).toHaveBeenCalledTimes(2)
  })

  it('TC4: 无 PTY 时 resize no-op 不记录 owner', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    // 未 spawn，无 PTY
    expect(() => svc.resize('no-pty', 80, 24, 'A', 'iMac')).not.toThrow()
    // 验证 owner 未记录：spawn 后 A resize 应成功（owner 不是 A 之外的值）
    await svc.spawn('s1', undefined, 80, 24)
    // no-pty 的 resize 不影响 s1
    svc.resize('s1', 100, 30, 'B', 'iPad')
    // 若 no-pty 记录了 owner，B 不会被拒——但 no-pty 用的是 'no-pty' sid，与 s1 无关
    expect(mockPtys.at(-1)!.resize).toHaveBeenCalledWith(100, 30)
  })

  it('TC6: destroyPty 清理该 sid 的 resizeOwner', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s1', undefined, 80, 24)
    svc.resize('s1', 100, 30, 'A', 'iMac')
    // destroyPty 后 owner 应清掉
    svc.destroyPty('s1')
    // 重新 spawn 后 B resize 应成功（owner 已清）
    await svc.spawn('s1', undefined, 80, 24)
    svc.resize('s1', 120, 40, 'B', 'iPad')
    expect(mockPtys.at(-1)!.resize).toHaveBeenCalledWith(120, 40)
  })

  it('TC2b: clearResizeOwner 只清指定 clientId（其他 session 的 owner 保留）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s1', undefined, 80, 24)
    await svc.spawn('s2', undefined, 80, 24)
    svc.resize('s1', 100, 30, 'A', 'iMac')
    svc.resize('s2', 100, 30, 'A', 'iMac')
    // A 断开清 s1+s2 的 owner
    svc.clearResizeOwner('A')
    // B 在 s1 resize 成功
    svc.resize('s1', 120, 40, 'B', 'iPad')
    expect(mockPtys[0]!.resize).toHaveBeenCalledWith(120, 40)
    // B 在 s2 resize 也成功（A 的 owner 都清了）
    svc.resize('s2', 120, 40, 'B', 'iPad')
    expect(mockPtys[1]!.resize).toHaveBeenCalledWith(120, 40)
  })
})
