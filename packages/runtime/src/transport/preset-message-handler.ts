/**
 * PresetMessageHandler — pi 启动预设域的 WS 消息处理。
 *
 * 设计文档：docs/design/pi-launch-presets.md（§8.1 API）
 *
 * 处理 6 个 preset.* 消息类型：
 * - preset.list：列出全部预设（内置 + 自定义）
 * - preset.getDefault：读全局默认预设 id
 * - preset.setDefault：设全局默认预设
 * - preset.create：创建自定义预设
 * - preset.update：更新预设（含内置预设的可编辑字段）
 * - preset.delete：删除自定义预设（内置不可删）
 *
 * 与 SettingsMessageHandler 对称（独立 handler，非 SettingsMessageHandler 内部 case）。
 * 职责单一：只做消息→PresetService 调用→reply，不含领域计算。
 *
 * 错误处理：PresetService.savePreset/deletePreset 抛 PresetGuardError 时，
 * handler 捕获后发 error envelope（code='preset_guard_error'），前端 toast 展示。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { PresetService } from '../services/preset-service.js'
import type { MessageHandlerContext } from './message-context.js'

/** PresetMessageHandler 的上下文接口（与 SettingsHandlerContext 对称）。 */
export interface PresetHandlerContext extends MessageHandlerContext {
  presetService: PresetService
}

/** preset.* 消息类型清单（供 server.ts routes Map spread）。 */
const PRESET_HANDLES = [
  'preset.list',
  'preset.getDefault',
  'preset.setDefault',
  'preset.create',
  'preset.update',
  'preset.delete',
] as const

export class PresetMessageHandler {
  constructor(private ctx: PresetHandlerContext) {}

  /** 本 handler 认领的消息类型清单（server.ts D1 路由表用）。 */
  get handles() {
    return PRESET_HANDLES
  }

  /**
   * 处理 preset.* 消息。
   *
   * 返回 true 表示已认领（即使出错也已 reply），false 不应出现（handles 保证匹配）。
   * 错误统一走 sendError（D10 error envelope），前端 catch 后 toast。
   */
  async handlePresetMessage(msg: ClientMessage, ws: WsType): Promise<boolean> {
    try {
      switch (msg.type) {
        case 'preset.list': {
          const presets = this.ctx.presetService.getAllPresets()
          this.ctx.reply(ws, msg.id, 'preset.list', { presets })
          return true
        }

        case 'preset.getDefault': {
          const presetId = this.ctx.presetService.getDefaultPresetId()
          this.ctx.reply(ws, msg.id, 'preset.getDefault', { presetId })
          return true
        }

        case 'preset.setDefault': {
          const { presetId } = msg.payload
          this.ctx.presetService.setDefaultPresetId(presetId)
          this.ctx.reply(ws, msg.id, 'preset.setDefault', {} as Record<string, never>)
          return true
        }

        case 'preset.create': {
          const { preset } = msg.payload
          this.ctx.presetService.savePreset(preset)
          // 返回保存后的预设（可能被 runtime 补全 id/order 等字段）
          const saved = this.ctx.presetService.getPreset(preset.id)
          this.ctx.reply(ws, msg.id, 'preset.create', { preset: saved ?? preset })
          return true
        }

        case 'preset.update': {
          const { preset } = msg.payload
          this.ctx.presetService.savePreset(preset)
          const saved = this.ctx.presetService.getPreset(preset.id)
          this.ctx.reply(ws, msg.id, 'preset.update', { preset: saved ?? preset })
          return true
        }

        case 'preset.delete': {
          const { presetId } = msg.payload
          this.ctx.presetService.deletePreset(presetId)
          this.ctx.reply(ws, msg.id, 'preset.delete', {} as Record<string, never>)
          return true
        }

        default:
          return false
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const code = (e as Error & { code?: string }).code ?? 'preset_guard_error'
      this.ctx.sendError(ws, code, message, msg.id)
      return true
    }
  }
}
