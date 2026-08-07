/**
 * SettingsMessageHandler config.getConnectionInfo 单测（wave 远程分享）。
 *
 * 验收：
 *  - TC1: 发 config.getConnectionInfo → handler reply 'config.connectionInfo' + 正确 payload（token + urls）
 *  - TC2: tokenManager 开放模式（enabled=false）→ reply 的 token 为空字符串
 *
 * mock：context（含 tokenManager + port + bindHost + reply）+ detectUrls（探测固定 urls 数组）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsMessageHandler } from '../settings-message-handler.js'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'

// mock detectUrls：返回固定 urls，避免真实网卡探测
const detectUrlsMock = vi.fn<() => Promise<ServerMessageMap['config.connectionInfo']['urls']>>()

vi.mock('../../server/detect-url.js', () => ({
  detectUrls: (...args: unknown[]) => detectUrlsMock(...(args as [])),
  // 旁路导出（detect-url.ts 其他 type 仅类型引用，无需运行时实现）
}))

// 仅取 urls 元素结构类型，避免引入完整 ServerMessageMap 依赖
type DetectedUrl = { kind: string; host: string; httpUrl: string; wsUrl: string }
type ServerMessageMap = Record<string, never> & {
  'config.connectionInfo': { urls: DetectedUrl[] }
}

interface MockCtx {
  reply: ReturnType<typeof vi.fn>
  sendError: ReturnType<typeof vi.fn>
  broadcast: ReturnType<typeof vi.fn>
  tokenManager: { load: ReturnType<typeof vi.fn> }
  port: number
  bindHost: string
}

function makeHandler(tokenEnabled: { enabled: boolean; token?: string }): {
  handler: SettingsMessageHandler
  ctx: MockCtx
} {
  const ctx: MockCtx = {
    reply: vi.fn(),
    sendError: vi.fn(),
    broadcast: vi.fn(),
    tokenManager: {
      load: vi.fn(() =>
        tokenEnabled.enabled
          ? { enabled: true, token: tokenEnabled.token ?? 'secret-token' }
          : { enabled: false },
      ),
    },
    port: 3310,
    bindHost: '0.0.0.0',
  }
  // SettingsMessageHandler 构造只需要 ctx 中它实际访问的字段；其余 broadcast* 等可选。
  // 用 partial cast 规避大量未用 broadcast 方法的类型负担。
  const handler = new SettingsMessageHandler(ctx as unknown as ConstructorParameters<typeof SettingsMessageHandler>[0])
  return { handler, ctx }
}

function getConnectionInfoMsg(id = 'm1'): ClientMessage {
  return {
    type: 'config.getConnectionInfo',
    id,
    payload: {},
  } as unknown as ClientMessage
}

const WS = {} as never

beforeEach(() => {
  detectUrlsMock.mockReset()
})

describe('SettingsMessageHandler config.getConnectionInfo（wave 远程分享）', () => {
  it('TC1: reply config.connectionInfo 含 token + 探测的 urls', async () => {
    const urls: DetectedUrl[] = [
      {
        kind: 'lan',
        host: '192.168.1.100',
        httpUrl: 'http://192.168.1.100:3310',
        wsUrl: 'ws://192.168.1.100:3310',
      },
    ]
    detectUrlsMock.mockResolvedValue(urls)

    const { handler, ctx } = makeHandler({ enabled: true, token: 'my-secret' })
    const result = await handler.handleSettingsMessage(getConnectionInfoMsg('m1'), WS)

    // handler 声明处理了此 type
    expect(result).toBe(true)
    // detectUrls 用 ctx.port 调用
    expect(detectUrlsMock).toHaveBeenCalledWith(3310)
    // tokenManager.load 被读
    expect(ctx.tokenManager.load).toHaveBeenCalledOnce()
    // reply 命名 envelope + 正确 payload
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'config.connectionInfo', {
      token: 'my-secret',
      urls,
    })
  })

  it('TC2: tokenManager 开放模式（enabled=false）→ reply token 为空字符串', async () => {
    const urls: DetectedUrl[] = [
      {
        kind: 'localhost',
        host: 'localhost',
        httpUrl: 'http://localhost:3310',
        wsUrl: 'ws://localhost:3310',
      },
    ]
    detectUrlsMock.mockResolvedValue(urls)

    const { handler, ctx } = makeHandler({ enabled: false })
    await handler.handleSettingsMessage(getConnectionInfoMsg('m2'), WS)

    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm2', 'config.connectionInfo', {
      token: '',
      urls,
    })
  })

  it('TC3: detectUrls 即使为空数组也正常 reply（best-effort 不抛错）', async () => {
    detectUrlsMock.mockResolvedValue([])

    const { handler, ctx } = makeHandler({ enabled: true, token: 't1' })
    await handler.handleSettingsMessage(getConnectionInfoMsg('m3'), WS)

    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm3', 'config.connectionInfo', {
      token: 't1',
      urls: [],
    })
  })
})
