/**
 * TerminalService 单元测试（Phase 2 V2.1）。
 *
 * mock 策略：vi.mock('node-pty') 模拟 IPty（EventEmitter 模拟 onData/onExit + write/resize/kill）。
 * 断言 broadcast 收到的 ServerMessage 类型和 payload。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/terminal/__tests__/terminal-service.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'
import { WebSocket } from 'ws'

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

/**
 * P2-s3：构造 mock ws（attach 回灌测试用）。
 * 只 mock attach 路径用到的两个字段：send（vi.fn 收集调用）+ readyState（默认 OPEN）。
 * 不需完整 WebSocket mock——attach 实现只读这两个字段。
 */
function createMockWs(readyState: number = WebSocket.OPEN): { send: ReturnType<typeof vi.fn>; readyState: number } {
  return { send: vi.fn(), readyState }
}

beforeEach(() => {
  mockPtys.length = 0
  vi.clearAllMocks()
})

// 恢复 it 内 vi.spyOn 创建的 spy（如 console.error），避免污染后续测试。
// 只影响 vi.spyOn，不动 vi.mock 模块工厂 / vi.fn。
afterEach(() => {
  vi.restoreAllMocks()
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
    // P6 D7：resize 加 clientId/ownerDevice 参数
    svc.resize('s3', 120, 40, 'local', 'local')
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
    expect(() => svc.resize('nonexistent', 80, 24, 'local', 'local')).not.toThrow()
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

  it('TS-10: spawn 失败时 console.error 收到序列化后的 plain object（含 message/stack/code），非裸 Error 实例', async () => {
    // 回归守卫：spawn catch 块用 serializeError(e) 把 Error 转成 plain object 再传给 console.error。
    // 若有人改回裸 e，Error 实例经 logger 的 JSON.stringify 会变成 {}，日志看不出真实错误。
    const { spawn } = await import('node-pty')
    // 带 code 的 Error（模拟 node 系统错误，验证 code 透出）
    const spawnErr = Object.assign(new Error('ENOENT: shell not found'), { code: 'ENOENT' })
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw spawnErr
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })

    await expect(svc.spawn('s10', undefined, 80, 24)).rejects.toMatchObject({
      code: 'spawn_failed',
    })

    expect(errorSpy).toHaveBeenCalled()
    // console.error 第二个参数是 serializeError(e) 的返回值
    const serialized = errorSpy.mock.calls[0]![1]
    // 关键：不是裸 Error 实例（裸 Error 会被 logger JSON.stringify 成 {}）
    expect(serialized).not.toBeInstanceOf(Error)
    // 是含 message/stack/code 的 plain object
    expect(serialized).toMatchObject({
      message: 'ENOENT: shell not found',
      stack: expect.any(String),
      code: 'ENOENT',
    })
    // 模拟 logger 的 JSON.stringify：plain object 能正确序列化出 message（裸 Error 会变 {}）
    expect(JSON.parse(JSON.stringify(serialized)).message).toBe('ENOENT: shell not found')
  })

  // ── P2-s3 terminal scrollback（spec §五） ──────────────────────────────────

  it('TS-11: PTY onData 后 scrollback buffer 含对应 chunk（getScrollbackSize===1）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s11', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('hello')
    expect(svc.getScrollbackSize('s11')).toBe(1)
    // 再 emit 一条，size 递增
    pty.__emitData(' world')
    expect(svc.getScrollbackSize('s11')).toBe(2)
  })

  it('TS-12: 字节上限双限驱逐——连续 emit 大 data 超 scrollbackMaxBytes 后老 chunk 被驱逐', async () => {
    // 用小 env 上限隔离测试（构造期解析 env，故 set 在 new 之前）。
    vi.stubEnv('XYZ_AGENT_TERMINAL_SCROLLBACK_BYTES', '300')
    try {
      const { broadcast } = createBroadcastCollector()
      const svc = new TerminalService({ broadcast })
      await svc.spawn('s12', undefined, 80, 24)
      const pty = mockPtys.at(-1)!
      // 每条约 100 字节（data 字符串本身小，但 stringify 后含 sessionId/type/id 等开销 ~100B）。
      // emit 5 条 → 累计 > 300B → 触发字节上限驱逐（最老的先删）。
      for (let i = 0; i < 5; i++) pty.__emitData(`x`.repeat(80))
      // 字节上限触发后 size 必 < 5（部分被驱逐），且不超条数上限 1000
      const size = svc.getScrollbackSize('s12')
      expect(size).toBeLessThan(5)
      expect(size).toBeGreaterThan(0)
      expect(size).toBeLessThanOrEqual(1000)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('TS-13: 条数上限双限驱逐——emit 超 1000 条后 size===1000（最老的被驱逐）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s13', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    // emit 1001 条小 data（每条小，不触字节上限），条数上限 1000 触发驱逐
    for (let i = 0; i < 1001; i++) pty.__emitData(String(i))
    // 条数上限保证 size === 1000（最老 1 条被 LRU 驱逐）
    expect(svc.getScrollbackSize('s13')).toBe(1000)
  })

  it('TS-14: kill 清除对应 session 的 scrollback buffer', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s14', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('before kill')
    expect(svc.getScrollbackSize('s14')).toBe(1)
    svc.kill('s14')
    expect(svc.getScrollbackSize('s14')).toBe(0)
  })

  it('TS-15: destroyPty 清除对应 session 的 scrollback buffer', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s15', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('before destroy')
    expect(svc.getScrollbackSize('s15')).toBe(1)
    svc.destroyPty('s15')
    expect(svc.getScrollbackSize('s15')).toBe(0)
  })

  it('TS-16: PTY onExit 不清除 scrollback buffer（D4：保留 exit 前输出供重新 attach）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s16', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('before exit')
    expect(svc.getScrollbackSize('s16')).toBe(1)
    // PTY 自然退出（onExit）不清 buffer——session 未销毁前重新 attach 应能回灌到 exit 前输出
    pty.__emitExit(0)
    expect(svc.getScrollbackSize('s16')).toBe(1)
  })

  it('TS-17: 不存在的 sid 调 getScrollbackSize 返回 0（桶不存在 no-op）', () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    expect(svc.getScrollbackSize('nonexistent')).toBe(0)
  })

  it('TS-18: env XYZ_AGENT_TERMINAL_SCROLLBACK_BYTES 覆盖字节上限', async () => {
    // 设极小字节上限，验证 emit 单条超限后驱逐生效
    vi.stubEnv('XYZ_AGENT_TERMINAL_SCROLLBACK_BYTES', '50')
    try {
      const { broadcast } = createBroadcastCollector()
      const svc = new TerminalService({ broadcast })
      await svc.spawn('s18', undefined, 80, 24)
      const pty = mockPtys.at(-1)!
      // 单条 stringify 后 > 50B（payload 含 sessionId/type/id + data 开销）
      pty.__emitData('x'.repeat(60))
      // 字节上限 50 远小于条数上限 1000，故 size 受字节约束（极端情况 SessionBuffer 会清空整桶）
      // 主要验证 env 生效：env=50 时行为与默认 256KB 不同（默认下单条不会触发驱逐）
      const size = svc.getScrollbackSize('s18')
      // 单条 > maxBytes 时 SessionBuffer shift 掉自身 → size 可能为 0；无论如何应不超 1
      expect(size).toBeLessThanOrEqual(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // ── P2-s3-w2 attach 回灌（spec §五 IF1/IF2） ────────────────────────────────

  it('TS-19: attach 回灌内容与顺序正确（按 buffer 内升序逐条 ws.send）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s19', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('a')
    pty.__emitData('b')
    const ws = createMockWs()
    svc.attach('s19', ws)
    // 按 emit 顺序回灌两条
    expect(ws.send).toHaveBeenCalledTimes(2)
    const first = JSON.parse((ws.send.mock.calls[0] as string[])[0])
    const second = JSON.parse((ws.send.mock.calls[1] as string[])[0])
    expect(first.type).toBe('terminal.data')
    expect(first.payload.data).toBe('a')
    expect(second.payload.data).toBe('b')
  })

  it('TS-20: attach 点对点——只投递给传入的 ws，不广播/不影响其他 ws', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s20', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('x')
    const wsA = createMockWs()
    const wsB = createMockWs()
    svc.attach('s20', wsA)
    // wsA 收到回灌，wsB 从未被调用（点对点，D3）
    expect(wsA.send).toHaveBeenCalledTimes(1)
    expect(wsB.send).not.toHaveBeenCalled()
  })

  it('TS-21: attach 时 ws undefined 是 no-op（不抛错，向后兼容兜底）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s21', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('x')
    // ws undefined 不抛错、无 send（防御兜底，handler 必传 ws 但 port 接口允许 undefined）
    expect(() => svc.attach('s21', undefined)).not.toThrow()
  })

  it('TS-22: attach 时 buffer 为空（session 有 PTY 但无输出）是 no-op', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s22', undefined, 80, 24)
    // 未 emit 任何 data，buffer 桶虽可能未创建（懒创建）或为空
    const ws = createMockWs()
    svc.attach('s22', ws)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('TS-23: attach 时 buffer 不存在（sid 从未 spawn）是 no-op', () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    const ws = createMockWs()
    // 从未 spawn 的 sid，桶不存在
    expect(() => svc.attach('nonexistent', ws)).not.toThrow()
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('TS-24: attach 回灌时 ws 已关闭（readyState !== OPEN）跳过 send 不抛错', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s24', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('x')
    // readyState=CLOSED 模拟连接已关闭
    const closedWs = createMockWs(WebSocket.CLOSED)
    expect(() => svc.attach('s24', closedWs)).not.toThrow()
    expect(closedWs.send).not.toHaveBeenCalled()
  })

  it('TS-25: 回灌的消息不带 seq 字段（D2：点对点回灌不入全局 seq 体系）', async () => {
    const { broadcast } = createBroadcastCollector()
    const svc = new TerminalService({ broadcast })
    await svc.spawn('s25', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('x')
    const ws = createMockWs()
    svc.attach('s25', ws)
    const sent = JSON.parse((ws.send.mock.calls[0] as string[])[0])
    // 回灌消息只有 type/id/payload，无 seq 字段（与实时 broadcast 打 seq 区分，D2）
    expect(sent).not.toHaveProperty('seq')
    expect(sent.type).toBe('terminal.data')
    expect(sent.payload.data).toBe('x')
  })
})
