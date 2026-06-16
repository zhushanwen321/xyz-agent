/**
 * Settings and model configuration message handler mixin.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { IConfigService, ISessionService, IModelService } from '../interfaces.js'

/** Interface for server methods needed by this handler */
export interface SettingsHandlerContext {
  configService: IConfigService
  sessionService: ISessionService
  modelService: IModelService
  projectRoot: string
  nextPushId(): string
  send(ws: WsType, msg: ServerMessage): void
  sendError(ws: WsType, code: string, message: string, id?: string, sessionId?: string): void
  broadcast(msg: ServerMessage): void
  broadcastProviderList(): void
  broadcastSkillList(): void
  broadcastAgentList(): void
}

export class SettingsMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  async handleSettingsMessage(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getProviders':
        this.ctx.send(ws, { type: 'config.providers', id: msg.id, payload: { providers: this.ctx.configService.listProviders() } })
        return true
      case 'config.setProvider': {
        const { providerId, ...data } = msg.payload
        const setResult = this.ctx.configService.setProvider(providerId, data as Parameters<IConfigService['setProvider']>[1])
        this.ctx.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { providerId } })
        this.ctx.broadcastProviderList()
        // 如果 fallback 修正了 defaultModel，广播到所有 panel
        if (setResult.newDefault) {
          this.ctx.broadcast({
            type: 'config.defaults',
            id: this.ctx.nextPushId(),
            payload: { defaultModel: `${setResult.newDefault.provider}/${setResult.newDefault.modelId}`, source: 'provider-updated' as const },
          })
        }
        return true
      }
      case 'config.deleteProvider': {
        const delResult = this.ctx.configService.deleteProvider(msg.payload.providerId)
        this.ctx.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { providerId: msg.payload.providerId, deleted: true } })
        this.ctx.broadcastProviderList()
        // 如果 fallback 修正了 defaultModel，广播到所有 panel
        if (delResult.newDefault) {
          this.ctx.broadcast({
            type: 'config.defaults',
            id: this.ctx.nextPushId(),
            payload: { defaultModel: `${delResult.newDefault.provider}/${delResult.newDefault.modelId}`, source: 'provider-deleted' as const },
          })
        }
        return true
      }
      case 'config.setToolPermissions':
        this.ctx.configService.updateToolPermissions(msg.payload.permissions)
        this.ctx.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { saved: true } })
        return true
      case 'config.scanSkills': {
        const existingIds = new Set(this.ctx.configService.loadSkills(this.ctx.projectRoot).map(s => s.id))
        this.ctx.send(ws, { type: 'config.scannedSkills', id: msg.id, payload: { skills: this.ctx.configService.scanSkills(msg.payload.sources, existingIds), success: true } })
        return true
      }
      case 'config.setSkill': {
        this.ctx.configService.upsertSkill(msg.payload.skill)
        this.ctx.send(ws, { type: 'config.skillUpdated', id: msg.id, payload: { skill: msg.payload.skill, success: true } })
        this.ctx.broadcastSkillList()
        return true
      }
      case 'config.deleteSkill': {
        this.ctx.configService.deleteSkill(msg.payload.skillId)
        this.ctx.send(ws, { type: 'config.skillDeleted', id: msg.id, payload: { skillId: msg.payload.skillId, success: true } })
        this.ctx.broadcastSkillList()
        return true
      }
      case 'config.scanAgents': {
        const existingIds = new Set(this.ctx.configService.loadAgents(this.ctx.projectRoot).map(a => a.id))
        this.ctx.send(ws, { type: 'config.scannedAgents', id: msg.id, payload: { agents: this.ctx.configService.scanAgents(msg.payload.sources, existingIds), success: true } })
        return true
      }
      case 'config.setAgent': {
        this.ctx.configService.upsertAgent(msg.payload.agent)
        this.ctx.send(ws, { type: 'config.agentUpdated', id: msg.id, payload: { agent: msg.payload.agent, success: true } })
        this.ctx.broadcastAgentList()
        return true
      }
      case 'config.deleteAgent': {
        this.ctx.configService.deleteAgent(msg.payload.agentId)
        this.ctx.send(ws, { type: 'config.agentDeleted', id: msg.id, payload: { agentId: msg.payload.agentId, success: true } })
        this.ctx.broadcastAgentList()
        return true
      }
      case 'config.discoverModels': return this.handleDiscoverModels(msg, ws)
      case 'model.list':
        this.ctx.send(ws, { type: 'model.list', id: msg.id, payload: { models: this.ctx.modelService.aggregateModels(this.ctx.configService.listProviders()) } })
        return true
      case 'model.switch': {
        const { sessionId, provider, modelId } = msg.payload
        console.log(`[runtime] model.switch: sessionId=${sessionId}, provider=${provider}, modelId=${modelId}`)
        await this.ctx.modelService.switchModel(sessionId, provider, modelId)
        this.ctx.send(ws, { type: 'model.switched', id: msg.id, payload: { sessionId, provider, modelId } })
        return true
      }
      case 'session.setThinkingLevel': {
        const { sessionId: sid, level } = msg.payload
        await this.ctx.modelService.setThinkingLevel(sid as string, level as string)
        this.ctx.send(ws, { type: 'session.thinkingLevelSet', id: msg.id, payload: { sessionId: sid, level } })
        return true
      }
      case 'tool.approve':
      case 'tool.deny':
      case 'tool.always_allow':
        return true
      default: return false
    }
  }

  private handleDiscoverModels(msg: Extract<ClientMessage, { type: 'config.discoverModels' }>, ws: WsType): boolean {
    const { baseUrl, apiKey, providerType, providerId } = msg.payload
    let resolvedApiKey = apiKey
    if (!resolvedApiKey && providerId) resolvedApiKey = this.ctx.configService.getProvider(providerId)?.apiKey
    this.ctx.modelService.discoverModelsFromApi(baseUrl, resolvedApiKey, providerType)
      .then((models) => { this.ctx.send(ws, { type: 'config.discoveredModels', id: msg.id, payload: { models, success: true } }) })
      .catch((e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e)
        const message = raw.includes('ByteString') ? '请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符'
          : raw.includes('fetch failed') ? `连接失败：无法访问 ${baseUrl}/v1/models` : raw
        this.ctx.send(ws, { type: 'config.discoveredModels', id: msg.id, payload: { models: [], success: false, error: message } })
      })
    return true
  }
}
