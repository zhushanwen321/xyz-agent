/**
 * Settings and model configuration message handler mixin.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { IConfigService, ISessionService, IModelService } from '../interfaces.js'
import { toErrorMessage } from '../utils/errors.js'
import type { MessageHandlerContext } from './message-context.js'

/** Interface for server methods needed by this handler */
export interface SettingsHandlerContext extends MessageHandlerContext {
  configService: IConfigService
  sessionService: ISessionService
  modelService: IModelService
  projectRoot: string
  nextPushId(): string
  broadcast(msg: import('@xyz-agent/shared').ServerMessage): void
  broadcastProviderList(): void
  broadcastSkillList(): void
  broadcastAgentList(): void
  broadcastSkillDirs(): void
  broadcastAgentDirs(): void
}

export class SettingsMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  async handleSettingsMessage(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getProviders':
        this.ctx.reply(ws, msg.id, 'config.providers', { providers: this.ctx.configService.listProviders() })
        return true
      case 'config.setProvider': {
        const { providerId, ...data } = msg.payload
        const setResult = this.ctx.configService.setProvider(providerId, data as Parameters<IConfigService['setProvider']>[1])
        this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId })
        this.ctx.broadcastProviderList()
        // 如果 fallback 修正了 defaultModel，广播到所有 panel
        if (setResult.newDefault) {
          this.ctx.broadcast({
            type: 'config.defaults',
            id: this.ctx.nextPushId(),
            payload: { defaultModel: `${setResult.newDefault.provider}/${setResult.newDefault.modelId}`, source: 'provider-updated' },
          })
        }
        return true
      }
      case 'config.deleteProvider': {
        const delResult = this.ctx.configService.deleteProvider(msg.payload.providerId)
        this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId: msg.payload.providerId, deleted: true })
        this.ctx.broadcastProviderList()
        // 如果 fallback 修正了 defaultModel，广播到所有 panel
        if (delResult.newDefault) {
          this.ctx.broadcast({
            type: 'config.defaults',
            id: this.ctx.nextPushId(),
            payload: { defaultModel: `${delResult.newDefault.provider}/${delResult.newDefault.modelId}`, source: 'provider-deleted' },
          })
        }
        return true
      }
      case 'config.setToolPermissions':
        this.ctx.configService.updateToolPermissions(msg.payload.permissions)
        this.ctx.reply(ws, msg.id, 'config.providerUpdated', { saved: true })
        return true
      case 'config.scanSkills': {
        const existingIds = new Set(this.ctx.configService.loadSkills(this.ctx.projectRoot).map(s => s.id))
        this.ctx.reply(ws, msg.id, 'config.scannedSkills', { skills: this.ctx.configService.scanSkills(msg.payload.sources, existingIds), success: true })
        // 修裂缝①：扫描后广播最新 skill 列表（与 set/delete 对称），让前端 onSkills 订阅推回
        this.ctx.broadcastSkillList()
        return true
      }
      case 'config.setSkillDirs': {
        // ADR-0020 §1 目录级管道：覆盖 discovery.json.skillDirs（有序数组 = 优先级）
        this.ctx.configService.setSkillDirs(msg.payload.dirs)
        this.ctx.reply(ws, msg.id, 'config.skillDirs', { dirs: msg.payload.dirs.map((path) => ({ path, enabled: true })) })
        // 目录变更 → skill 列表重算 + 目录配置广播
        this.ctx.broadcastSkillList()
        this.ctx.broadcastSkillDirs()
        return true
      }
      case 'config.setSkill': {
        // @deprecated ADR-0020 §5：保留兼容期，走 deprecated config-service 路径
        this.ctx.configService.upsertSkill(msg.payload.skill)
        this.ctx.reply(ws, msg.id, 'config.skillUpdated', { skill: msg.payload.skill, success: true })
        this.ctx.broadcastSkillList()
        return true
      }
      case 'config.deleteSkill': {
        // @deprecated ADR-0020 §5：保留兼容期
        this.ctx.configService.deleteSkill(msg.payload.skillId)
        this.ctx.reply(ws, msg.id, 'config.skillDeleted', { skillId: msg.payload.skillId, success: true })
        this.ctx.broadcastSkillList()
        return true
      }
      case 'config.scanAgents': {
        const existingIds = new Set(this.ctx.configService.loadAgents(this.ctx.projectRoot).map(a => a.id))
        this.ctx.reply(ws, msg.id, 'config.scannedAgents', { agents: this.ctx.configService.scanAgents(msg.payload.sources, existingIds), success: true })
        // 修裂缝①：扫描后广播最新 agent 列表
        this.ctx.broadcastAgentList()
        return true
      }
      case 'config.setAgentDirs': {
        // ADR-0020 §1 目录级管道：覆盖 discovery.json.agentDirs（有序数组 = 优先级）
        this.ctx.configService.setAgentDirs(msg.payload.dirs)
        this.ctx.reply(ws, msg.id, 'config.agentDirs', { dirs: msg.payload.dirs.map((path) => ({ path, enabled: true })) })
        this.ctx.broadcastAgentList()
        this.ctx.broadcastAgentDirs()
        return true
      }
      case 'config.setAgent': {
        // @deprecated ADR-0020 §5：保留兼容期
        this.ctx.configService.upsertAgent(msg.payload.agent)
        this.ctx.reply(ws, msg.id, 'config.agentUpdated', { agent: msg.payload.agent, success: true })
        this.ctx.broadcastAgentList()
        return true
      }
      case 'config.deleteAgent': {
        // @deprecated ADR-0020 §5：保留兼容期
        this.ctx.configService.deleteAgent(msg.payload.agentId)
        this.ctx.reply(ws, msg.id, 'config.agentDeleted', { agentId: msg.payload.agentId, success: true })
        this.ctx.broadcastAgentList()
        return true
      }
      case 'config.discoverModels': return this.handleDiscoverModels(msg, ws)
      case 'model.list':
        this.ctx.reply(ws, msg.id, 'model.list', { models: this.ctx.modelService.aggregateModels(this.ctx.configService.listProviders()) })
        return true
      case 'model.switch': {
        const { sessionId, provider, modelId } = msg.payload
        console.log(`[runtime] model.switch: sessionId=${sessionId}, provider=${provider}, modelId=${modelId}`)
        await this.ctx.modelService.switchModel(sessionId, provider, modelId)
        this.ctx.reply(ws, msg.id, 'model.switched', { sessionId, provider, modelId })
        return true
      }
      case 'config.setDefaultModel': {
        // W3 默认模型持久化：configService.setDefaultModel 已存在（写 settings.json）。
        // reply 回发起端（不带 source） + 广播给所有 panel（带 source='default-set'），与
        // setProvider/deleteProvider 的 newDefault 广播同构，让其它打开的设置面板同步默认模型下拉。
        // reply 与 broadcast 共用 ServerMessageMap['config.defaults'] 类型，source 为 optional。
        const { provider, modelId } = msg.payload
        this.ctx.configService.setDefaultModel(provider, modelId)
        this.ctx.reply(ws, msg.id, 'config.defaults', {
          defaultModel: `${provider}/${modelId}`,
        })
        this.ctx.broadcast({
          type: 'config.defaults',
          id: this.ctx.nextPushId(),
          payload: { defaultModel: `${provider}/${modelId}`, source: 'default-set' },
        })
        return true
      }
      case 'config.getSystemPrompt': {
        // FR-6：读取 system-prompt 配置。corrupted 透传给前端（提示用户文件已损坏并重置）。
        const result = this.ctx.configService.getSystemPromptConfig()
        this.ctx.reply(ws, msg.id, 'config.systemPrompt', {
          config: result.config,
          corrupted: result.corrupted,
        })
        return true
      }
      case 'config.setSystemPrompt': {
        // FR-6：写入 system-prompt 配置。失败（超长等）按 D10 错误信封回复，不广播；
        // 成功 reply + 广播 config.systemPrompt（corrupted=false）让所有 panel 同步。
        const { config } = msg.payload
        const result = this.ctx.configService.setSystemPromptConfig(config)
        if (!result.ok) {
          this.ctx.sendError(ws, 'set_system_prompt_failed', result.error ?? 'unknown error', msg.id)
          return true
        }
        this.ctx.reply(ws, msg.id, 'config.systemPrompt', { config, corrupted: false })
        this.ctx.broadcast({
          type: 'config.systemPrompt',
          id: this.ctx.nextPushId(),
          payload: { config, corrupted: false },
        })
        return true
      }
      case 'session.setThinkingLevel': {
        const { sessionId: sid, level } = msg.payload
        await this.ctx.modelService.setThinkingLevel(sid as string, level as string)
        this.ctx.reply(ws, msg.id, 'session.thinkingLevelSet', { sessionId: sid, level })
        return true
      }
      // tool.approve / tool.deny / tool.always_allow：已删除的 no-op 占位。
      // 这些 type 此前只是 `return true` 以避免 unknown_type，但工具审批的实际路径是
      // pi 的 extension_ui_request（method:'confirm'）→ extension.ui_request/ui_response 流
      // （event-adapter 翻译，见 infra/pi/event-adapter.ts），「总是允许」由 config.setToolPermissions
      // 声明式 toolPermissions 配置覆盖。renderer 从不发送 tool.approve/deny/always_allow，
      // 无真实 handler。现在这些消息会落入 default → return false → server 发 unknown_type，
      // 即对真正未知 type 的正确兜底行为。
      default: return false
    }
  }

  private handleDiscoverModels(msg: Extract<ClientMessage, { type: 'config.discoverModels' }>, ws: WsType): boolean {
    const { baseUrl, apiKey, providerType, providerId } = msg.payload
    let resolvedApiKey = apiKey
    if (!resolvedApiKey && providerId) resolvedApiKey = this.ctx.configService.getProvider(providerId)?.apiKey
    // 错误文案翻译（ByteString / fetch failed → 中文）已下沉 model-service；
    // handler 只 reply service 返回的 models 或 error.message。
    this.ctx.modelService.discoverModelsFromApi(baseUrl, resolvedApiKey, providerType)
      .then((models) => { this.ctx.reply(ws, msg.id, 'config.discoveredModels', { models, success: true }) })
      .catch((e: unknown) => {
        this.ctx.reply(ws, msg.id, 'config.discoveredModels', { models: [], success: false, error: toErrorMessage(e) })
      })
    return true
  }
}
