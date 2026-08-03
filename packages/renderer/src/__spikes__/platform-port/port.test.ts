import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  InMemoryStorage,
  MockWebSocket,
  MockWebSocketFactory,
  ReadyState,
  createMockPlatform,
  providePlatform,
  getPlatform,
  __resetPlatformForTesting,
} from './port'

// TC-2: getPlatform() 未注入前调用抛错（fail-fast）
describe('getPlatform fail-fast', () => {
  beforeEach(() => {
    __resetPlatformForTesting()
  })

  it('未注入前调用抛错（信息含 not provided）', () => {
    expect(() => getPlatform()).toThrow(/not provided/i)
  })
})

// TC-3: providePlatform(createMockPlatform()) 后 getPlatform() 返回 mock 实例
describe('providePlatform + createMockPlatform', () => {
  beforeEach(() => {
    __resetPlatformForTesting()
  })

  it('注入后返回默认 mock 实例（kind/storage/webSocket/ipc 均为默认值）', () => {
    providePlatform(createMockPlatform())
    const p = getPlatform()
    expect(p.kind).toBe('mock')
    expect(p.storage).toBeInstanceOf(InMemoryStorage)
    expect(p.webSocket).toBeInstanceOf(MockWebSocketFactory)
    expect(p.ipc).toBeNull()
  })

  it('overrides 局部替换生效（kind: mock → web）', () => {
    providePlatform(createMockPlatform({ kind: 'web' }))
    expect(getPlatform().kind).toBe('web')
  })
})

// TC-4: InMemoryStorage get/set/remove 行为（读/写/删除/降级）
describe('InMemoryStorage', () => {
  it('get 不存在的 key 返回 null（非抛错）', async () => {
    const s = new InMemoryStorage()
    expect(await s.get('missing')).toBeNull()
  })

  it('set 后 get 返回写入值', async () => {
    const s = new InMemoryStorage()
    await s.set('k', 'v')
    expect(await s.get('k')).toBe('v')
  })

  it('remove 后 get 返回 null', async () => {
    const s = new InMemoryStorage()
    await s.set('k', 'v')
    await s.remove('k')
    expect(await s.get('k')).toBeNull()
  })

  it('remove 不存在的 key 不抛错（降级吞错）', async () => {
    const s = new InMemoryStorage()
    await expect(s.remove('never-existed')).resolves.toBeUndefined()
  })
})

// TC-5: MockWebSocketFactory + MockWebSocket 事件触发
describe('MockWebSocketFactory + MockWebSocket', () => {
  it('create 返回初始 CONNECTING 的 MockWebSocket，记录 url 与 created', () => {
    const f = new MockWebSocketFactory()
    const ws = f.create('ws://test')
    expect(ws).toBeInstanceOf(MockWebSocket)
    expect(ws.readyState).toBe(ReadyState.CONNECTING)
    expect(ws.url).toBe('ws://test')
    expect(f.created).toHaveLength(1)
    expect(f.created[0]).toBe(ws)
  })

  it('mockOpen 触发 open listener 并将 readyState 置 OPEN', () => {
    const ws = new MockWebSocket('ws://x')
    const openListener = vi.fn()
    ws.addEventListener('open', openListener)
    ws.mockOpen()
    expect(openListener).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(ReadyState.OPEN)
  })

  it('mockMessage 触发 message listener（携带 data）', () => {
    const ws = new MockWebSocket('ws://x')
    const msgListener = vi.fn()
    ws.addEventListener('message', msgListener)
    ws.mockMessage('hello')
    expect(msgListener).toHaveBeenCalledWith({ data: 'hello' })
  })

  it('mockClose 触发 close listener 并将 readyState 置 CLOSED', () => {
    const ws = new MockWebSocket('ws://x')
    const closeListener = vi.fn()
    ws.addEventListener('close', closeListener)
    ws.mockClose()
    expect(closeListener).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(ReadyState.CLOSED)
  })

  it('close() 同 mockClose：触发 close listener + readyState CLOSED', () => {
    const ws = new MockWebSocket('ws://x')
    const closeListener = vi.fn()
    ws.addEventListener('close', closeListener)
    ws.close()
    expect(closeListener).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(ReadyState.CLOSED)
  })

  it('send 记录到 sentMessages（供断言）', () => {
    const ws = new MockWebSocket('ws://x')
    ws.send('ping')
    ws.send('pong')
    expect(ws.sentMessages).toEqual(['ping', 'pong'])
  })

  it('mockError 触发 error listener', () => {
    const ws = new MockWebSocket('ws://x')
    const errListener = vi.fn()
    ws.addEventListener('error', errListener)
    ws.mockError({ message: 'boom' })
    expect(errListener).toHaveBeenCalledWith({ message: 'boom' })
  })

  it('removeEventListener 取消订阅（不再触发）', () => {
    const ws = new MockWebSocket('ws://x')
    const listener = vi.fn()
    ws.addEventListener('open', listener)
    ws.removeEventListener('open', listener)
    ws.mockOpen()
    expect(listener).not.toHaveBeenCalled()
  })

  it('4 个 ReadyState 常量值与 DOM WebSocket 一致', () => {
    expect(ReadyState.CONNECTING).toBe(0)
    expect(ReadyState.OPEN).toBe(1)
    expect(ReadyState.CLOSING).toBe(2)
    expect(ReadyState.CLOSED).toBe(3)
    // MockWebSocket 实例上的常量属性同值
    const ws = new MockWebSocket('ws://x')
    expect(ws.CONNECTING).toBe(0)
    expect(ws.OPEN).toBe(1)
    expect(ws.CLOSING).toBe(2)
    expect(ws.CLOSED).toBe(3)
  })
})
