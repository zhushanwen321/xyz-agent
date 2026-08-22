/**
 * QuotaMessageHandler 测试 — A1-5 configure await 竞态守卫（round 1 review SUGGESTION）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/transport/quota-message-handler.test.ts
 *
 * 重点：configure await 化是行为修复（commit 91e6157a8）——持久化切到 providers.json
 *（proper-lockfile RMW 异步落盘）后，去掉 await 回归时 reply 会先于落盘发出且携带
 * 未 resolve 的 Promise 作 payload（修复前 configure 是同步函数、reply 直接拿结果，
 * 切异步后 fire-and-forget 形态 = `const result = configure(...)` 不 await 即 reply）。
 * 用可控 deferred 断言时序：configure pending 期间 reply 不发出，resolve 后 reply
 * 携带真实结果——两条断言在「去掉 await」回归下均红。
 */
import { describe, it, expect, vi } from 'vitest'
import { QuotaMessageHandler, type QuotaHandlerContext } from './quota-message-handler.js'
import type { ClientMessage } from '@xyz-agent/shared'
import type { QuotaService } from '../services/quota-service.js'

function mockContext(quotaService: Partial<QuotaService>): QuotaHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    quotaService: quotaService as QuotaService,
  }
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'm1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}
const WS = {} as never

describe('QuotaMessageHandler · quota.configure await 竞态（A1-5）', () => {
  it('configure 落盘完成（pending）期间 reply 不发出；resolve 后 reply 携带真实结果', async () => {
    // 可控 deferred：configure 返回 pending promise，resolve 时机由测试掌握
    let resolveConfigure!: (v: { ok: boolean }) => void
    const configure = vi.fn().mockImplementation(
      () => new Promise<{ ok: boolean }>(resolve => { resolveConfigure = resolve }),
    )
    const ctx = mockContext({ configure })
    const handler = new QuotaMessageHandler(ctx)

    const pending = handler.handleQuotaMessage(
      msg('quota.configure', { providerId: 'zai-coding-cn', enabled: true }), WS,
    )

    // 排空全部微任务 + 一个宏任务周期：若 handler 去掉 await（回归形态），reply 会在
    // configure 仍 pending 时先行发出——此处即红（时序判别点 1）
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.reply).not.toHaveBeenCalled()

    resolveConfigure({ ok: true })
    await pending
    // reply 携带 resolve 后的真实结果，不是未决 Promise（时序判别点 2：
    // 回归形态下 payload 是 Promise 对象，toEqual 深比较不匹配）
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'quota.configure:result', { ok: true })
  })

  it('configure 返回 ok:false → reply 原样携带错误面', async () => {
    const ctx = mockContext({ configure: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }) })
    const handler = new QuotaMessageHandler(ctx)

    await handler.handleQuotaMessage(
      msg('quota.configure', { providerId: 'zai-coding-cn', enabled: false }), WS,
    )
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'm1', 'quota.configure:result', { ok: false, error: 'boom' })
  })
})

describe('QuotaMessageHandler · providerId 防御（W3）', () => {
  it.each(['quota.fetch', 'quota.refresh', 'quota.getCached', 'quota.configure'] as const)(
    '%s 缺 providerId → sendError invalid_payload，不触达 service',
    async (type) => {
      const service = {
        fetch: vi.fn(),
        refresh: vi.fn(),
        getCached: vi.fn(),
        configure: vi.fn(),
      }
      const ctx = mockContext(service)
      const handler = new QuotaMessageHandler(ctx)

      await handler.handleQuotaMessage(msg(type, { enabled: true }), WS)

      expect(ctx.sendError).toHaveBeenCalledWith(WS, 'invalid_payload', 'providerId required', 'm1')
      expect(ctx.reply).not.toHaveBeenCalled()
      expect(service.fetch).not.toHaveBeenCalled()
      expect(service.refresh).not.toHaveBeenCalled()
      expect(service.getCached).not.toHaveBeenCalled()
      expect(service.configure).not.toHaveBeenCalled()
    },
  )
})
