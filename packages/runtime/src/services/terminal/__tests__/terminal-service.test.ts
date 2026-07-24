/**
 * TerminalService 单元测试（Phase 2 V2.1）。
 *
 * mock 策略：vi.mock('node-pty') 模拟 IPty（EventEmitter 模拟 onData/onExit + write/resize/kill）。
 * 断言 broadcast 收到的 ServerMessage 类型和 payload。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/terminal/__tests__/terminal-service.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'

// ── mock node-pty ─────────────────────────────────────────────────────────
// vi.mock 工厂被 hoisting 提升到文件顶，不能直接引用模块级变量。
// 用 vi.hoisted 创建跨工厂/测试共享的容器（vitest 标准范式）。
const { mockPtys, createMockPty } = vi.hoisted(() => {
  // IPty 的 onData/onExit 是 IEvent<T>（(listener) => IDisposable），非 EventEmitter。
  // mock 实现：维护 listener 列表，emit 时遍历调用。
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
    // 用 vi.fn 包装让测试能 toHaveBeenCalled 断言
    pty.write = vi.fn()
    pty.resize = vi.fn()
    pty.kill = vi.fn()
    mockPtys.push(pty)
    return pty
  }),
}))

// import 必须在 vi.mock 之后
const { TerminalService } = await import('../terminal-service.js')

/** 收集 broadcast 收到的消息。 */
function createBroadcastCollector() {
  const messages: ServerMessage[] = []
  const broadcast = (msg: ServerMessage) => messages.push(msg)
  return { messages, broadcast }
}

/** 从消息列表找指定 type。 */
function findMsg(msgs: ServerMessage[], type: string): ServerMessage | undefined {
  return msgs.find((m) => m.type === type)
}

beforeEach(() => {
  mockPtys.length = 0
  vi.clearAllMocks()
})

describe('TerminalService', () => {
  it('TS-1: spawn 后广播 terminal.alive，ptyMap 持有 sid', async () => {
    const { messages, broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s1', '/tmp', 80, 24)
    const alive = findMsg(messages, 'terminal.alive')
    expect(alive).toBeDefined()
    expect((alive!.payload as { sessionId: string }).sessionId).toBe('s1')
    // write 能找到 PTY（间接证明 ptyMap 持有）
    svc.write('s1', 'echo hi\n')
    expect(mockPtys[0]!.write).toHaveBeenCalledWith('echo hi\n')
  })

  it('TS-2: write 转发到 pty.write', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s2', undefined, 80, 24)
    svc.write('s2', 'ls -la')
    expect(mockPtys.at(-1)!.write).toHaveBeenCalledWith('ls -la')
  })

  it('TS-3: resize 转发到 pty.resize', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s3', undefined, 80, 24)
    svc.resize('s3', 120, 40)
    expect(mockPtys.at(-1)!.resize).toHaveBeenCalledWith(120, 40)
  })

  it('TS-4: PTY onData 触发 terminal.data 广播（含 sessionId + data）', async () => {
    const { messages, broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s4', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('hello world\r\n')
    const dataMsg = findMsg(messages, 'terminal.data')
    expect(dataMsg).toBeDefined()
    expect((dataMsg!.payload as { sessionId: string; data: string })).toMatchObject({
      sessionId: 's4',
      data: 'hello world\r\n',
    })
  })

  it('TS-5: PTY onExit 触发 terminal.exit 广播 + 清理 ptyMap', async () => {
    const { messages, broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s5', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitExit(42)
    const exitMsg = findMsg(messages, 'terminal.exit')
    expect(exitMsg).toBeDefined()
    expect((exitMsg!.payload as { exitCode: number }).exitCode).toBe(42)
    // 清理后 write 不再转发（ptyMap 已删）
    svc.write('s5', 'should be no-op')
    expect(pty.write).not.toHaveBeenCalledWith('should be no-op')
  })

  it('TS-6: destroyPty 调 pty.kill + 清 ptyMap', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s6', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    svc.destroyPty('s6')
    expect(pty.kill).toHaveBeenCalled()
    // 清理后 write no-op
    svc.write('s6', 'x')
    expect(pty.write).not.toHaveBeenCalledWith('x')
  })

  it('TS-7: kill 不存在的 sid 是 no-op（不抛错）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    expect(() => svc.kill('nonexistent')).not.toThrow()
    expect(() => svc.write('nonexistent', 'x')).not.toThrow()
    expect(() => svc.resize('nonexistent', 80, 24)).not.toThrow()
    expect(() => svc.destroyPty('nonexistent')).not.toThrow()
  })

  it('TS-8: spawn 幂等（同 sid 重复 spawn 不新建 PTY）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s8', undefined, 80, 24)
    await svc.spawn('s8', undefined, 80, 24)
    // node-pty.spawn 应只被调一次
    const { spawn } = await import('node-pty')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('TS-9: spawn 失败抛 spawn_failed 错误（含 code）', async () => {
    const { spawn } = await import('node-pty')
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('ENOENT: shell not found')
    })
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await expect(svc.spawn('s9', undefined, 80, 24)).rejects.toMatchObject({
      code: 'spawn_failed',
      message: expect.stringContaining('shell not found'),
    })
  })
})
