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

/** Quota handler 的上下文（共享发消息契约 + QuotaService + provider 列表广播） */
export interface QuotaHandlerContext extends MessageHandlerContext {
  quotaService: QuotaService
  /**
   * 广播最新 provider 列表（config.providers）。quota.configure 成功后必调——
   * quota 配置落在 providers.json 的 extras，renderer 侧 matchedProviderId（容量浮层
   * coding-plan 区的显隐依据）读 settingsStore.providers 快照；不广播则快照停留在
   * 旧值（无 quota 字段），配置后须重启（sendInitialState 首推）才生效。
   */
  broadcastProviderList: () => void
}

export class QuotaMessageHandler {
  constructor(private ctx: QuotaHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['quota.fetch', 'quota.getCached', 'quota.configure', 'quota.refresh']

  async handleQuotaMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'quota.fetch': {
        const { providerId } = msg.payload
        // [W3] 防御 undefined/非 string providerId，避免下游 quotaService.fetch(undefined) 静默返回缓存
        if (!providerId || typeof providerId !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'providerId required', msg.id)
          return
        }
        const result = await this.ctx.quotaService.fetch(providerId)
        this.ctx.reply(ws, msg.id, 'quota.fetch:result', result)
        return
      }
      case 'quota.refresh': {
        const { providerId } = msg.payload
        if (!providerId || typeof providerId !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'providerId required', msg.id)
          return
        }
        // 强制刷新（绕过 throttle），用于 Settings 测试查询
        const result = await this.ctx.quotaService.refresh(providerId)
        this.ctx.reply(ws, msg.id, 'quota.refresh:result', result)
        return
      }
      case 'quota.getCached': {
        const { providerId } = msg.payload
        if (!providerId || typeof providerId !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'providerId required', msg.id)
          return
        }
        const result = this.ctx.quotaService.getCached(providerId)
        this.ctx.reply(ws, msg.id, 'quota.getCached:result', result)
        return
      }
      case 'quota.configure': {
        const { providerId, enabled, cookie, fetcher, apiKey, workspace } = msg.payload
        if (!providerId || typeof providerId !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'providerId required', msg.id)
          return
        }
        // A1-5：configure 持久化走 providers.json（统一 mkdir 锁 RMW），await 防止
        // reply 先于落盘（handler 返回时配置已持久，broadcast/后续读不拿 stale）
        const result = await this.ctx.quotaService.configure(providerId, enabled, cookie, fetcher, apiKey, workspace)
        // 成功后广播 provider 列表：quota 配置进 providers.json extras，renderer 的
        // matchedProviderId 消费 providers 快照——不广播则须重启才生效（同
        // setProvider/toggleProviderEnabled 等 provider 变更 RPC 的广播惯例）
        if (result.ok) this.ctx.broadcastProviderList()
        this.ctx.reply(ws, msg.id, 'quota.configure:result', result)
        return
      }
    }
  }
}
