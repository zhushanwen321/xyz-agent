/**
 * Quota message handler — Coding Plan 额度查询 RPC 处理。
 *
 * 处理 3 个 RPC：
 * - quota.fetch：hover 触发主动查询
 * - quota.getCached：读缓存不请求（浮层首屏即时填充）
 * - quota.configure：Settings 配置（启用/禁用/写 cookie）
 */

import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { QuotaService } from '../services/quota-service.js'

/** Quota handler 的上下文（共享发消息契约 + QuotaService） */
export interface QuotaHandlerContext extends MessageHandlerContext {
  quotaService: QuotaService
}

export class QuotaMessageHandler {
  constructor(private ctx: QuotaHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['quota.fetch', 'quota.getCached', 'quota.configure', 'quota.refresh']

  async handleQuotaMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'quota.fetch': {
        const { providerId } = msg.payload
        const result = await this.ctx.quotaService.fetch(providerId)
        this.ctx.reply(ws, msg.id, 'quota.fetch:result', result)
        return
      }
      case 'quota.refresh': {
        const { providerId } = msg.payload
        // 强制刷新（绕过 throttle），用于 Settings 测试查询
        const result = await this.ctx.quotaService.refresh(providerId)
        this.ctx.reply(ws, msg.id, 'quota.refresh:result', result)
        return
      }
      case 'quota.getCached': {
        const { providerId } = msg.payload
        const result = this.ctx.quotaService.getCached(providerId)
        this.ctx.reply(ws, msg.id, 'quota.getCached:result', result)
        return
      }
      case 'quota.configure': {
        const { providerId, enabled, cookie, fetcher, apiKey } = msg.payload
        const result = this.ctx.quotaService.configure(providerId, enabled, cookie, fetcher, apiKey)
        this.ctx.reply(ws, msg.id, 'quota.configure:result', result)
        return
      }
    }
  }
}
