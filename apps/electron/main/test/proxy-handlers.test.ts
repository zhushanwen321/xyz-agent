/**
 * 代理配置 IPC 测试（从 update-handlers.test.ts 搬迁）。
 *
 * 验证 'proxy:get' / 'proxy:set' / 'proxy:test' 三 channel：
 *   - proxy:get 文件不存在返回默认 {mode:'system'}
 *   - proxy:set 读写 round-trip + 三种非法输入校验
 *   - proxy:test disabled/manual 无 URL/dispatcher 透传（C2 回归防护）
 *
 * Mock 策略：vi.mock('electron') 捕获 ipcMain.handle 到 Map +
 * XYZ_AGENT_DATA_DIR 指向临时目录隔离真实配置文件 + global fetch mock 验证 dispatcher 透传。
 *
 * 运行：cd apps/electron/main && npx vitest run test/proxy-handlers.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 捕获注册的 handler（key=channel, value=handler fn）
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

import { registerProxyHandlers } from '../gateway/proxy-handlers.js'

describe('proxy-handlers: proxy config IPC', () => {
  // [ISOLATION] proxy:get 读 getDataDir()/proxy-config.json，而 getDataDir() 默认
  // 指向真实 ~/.xyz-agent。本机 ~/.xyz-agent/proxy-config.json 含 manual 配置，
  // 会导致「文件不存在」的默认值测试失败。把 XYZ_AGENT_DATA_DIR 指向临时目录隔离。
  let prevDataDir: string | undefined
  /** 保存/还原 global fetch（proxy:test manual 模式测试 mock 它验证 dispatcher 透传） */
  let originalFetch: typeof globalThis.fetch | undefined

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    prevDataDir = process.env.XYZ_AGENT_DATA_DIR
    process.env.XYZ_AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), 'xyz-proxy-test-'))
  })

  afterEach(() => {
    if (prevDataDir === undefined) {
      delete process.env.XYZ_AGENT_DATA_DIR
    } else {
      process.env.XYZ_AGENT_DATA_DIR = prevDataDir
    }
    // 还原 global fetch（proxy:test manual 模式测试会 mock 它）
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch
      originalFetch = undefined
    }
  })

  it('proxy:get 返回默认配置（文件不存在）', async () => {
    registerProxyHandlers({} as never)
    const handler = handlers.get('proxy:get')!
    const result = await handler({}, {})
    expect(result).toEqual({ mode: 'system' })
  })

  it('proxy:set 保存配置 + proxy:get 读取', async () => {
    registerProxyHandlers({} as never)
    const setHandler = handlers.get('proxy:set')!
    const getHandler = handlers.get('proxy:get')!

    // 保存手动配置
    await setHandler({}, {
      mode: 'manual',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
    })

    // 读取验证
    const result = await getHandler({}, {})
    expect(result).toEqual({
      mode: 'manual',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
    })
  })

  it('proxy:set 校验无效模式', async () => {
    registerProxyHandlers({} as never)
    const handler = handlers.get('proxy:set')!
    await expect(handler({}, { mode: 'invalid' })).rejects.toThrow('Invalid proxy mode')
  })

  it('proxy:set 手动模式缺少 httpProxy 报错', async () => {
    registerProxyHandlers({} as never)
    const handler = handlers.get('proxy:set')!
    await expect(handler({}, { mode: 'manual' })).rejects.toThrow('HTTP proxy is required in manual mode')
  })

  it('proxy:set 手动模式无效 URL 报错', async () => {
    registerProxyHandlers({} as never)
    const handler = handlers.get('proxy:set')!
    await expect(handler({}, {
      mode: 'manual',
      httpProxy: 'not-a-url',
    })).rejects.toThrow('Invalid proxy URL format')
  })

  it('proxy:test disabled 模式跳过测试并返回 success:false', async () => {
    // [B2] disabled 本就无连接可测，不应误报成功（前端据此显示「代理已禁用，跳过测试」）
    registerProxyHandlers({} as never)
    const handler = handlers.get('proxy:test')!
    const result = await handler({}, { mode: 'disabled' })
    expect(result).toEqual({ success: false, message: 'Proxy disabled, skipping test' })
  })

  // [C2/S-3 回归防护] proxy:test 必须真正走代理：fetch 收到含 dispatcher 的 options。
  // 旧实现只直连（不传 dispatcher）→ 代理不可用也误报成功。
  it('proxy:test manual 模式 → fetch 被传含 dispatcher 的 options（真正走代理）', async () => {
    // mock global fetch：返回 ok Response，让 testProxyConnection 走到 fetch 调用。
    // 显式声明 fetch 形参类型，mock.calls 才有正确的元组形状（url, init）。
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    )
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    registerProxyHandlers({} as never)
    const handler = handlers.get('proxy:test')!
    const result = await handler({}, {
      mode: 'manual',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
    })

    // fetch 被调用且第 2 参数（RequestInit）含 dispatcher 字段 → C2 修复生效
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]
    expect(call).toBeDefined()
    const initArg = call![1] as RequestInit & { dispatcher?: unknown } | undefined
    expect(initArg).toBeDefined()
    expect(initArg!.dispatcher).toBeDefined()
    expect(initArg!.dispatcher).not.toBeNull()
    // 走代理成功
    expect(result).toEqual({ success: true })
  })

  it('proxy:test manual 模式无代理 URL → success:false', async () => {
    registerProxyHandlers({} as never)
    const handler = handlers.get('proxy:test')!
    const result = await handler({}, { mode: 'manual' })
    expect(result).toEqual({ success: false, message: 'No proxy URL configured' })
  })
})
