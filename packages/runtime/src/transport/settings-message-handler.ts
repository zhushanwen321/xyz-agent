/**
 * Settings and model configuration message handler mixin.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ProviderSource, SkillCacheScope } from '@xyz-agent/shared'
import type { IConfigService, ISessionService, IModelService } from '../interfaces.js'
import type { SkillRegistry } from '../services/skill-registry.js'
import { toErrorMessage } from '../utils/errors.js'
import { VersionConflictError } from '../services/config-service.js'
import type { MessageHandlerContext } from './message-context.js'
import type { TokenManager } from './token.js'
import { detectUrls } from '../server/detect-url.js'

/** Interface for server methods needed by this handler */
export interface SettingsHandlerContext extends MessageHandlerContext {
  configService: IConfigService
  sessionService: ISessionService
  modelService: IModelService
  /** W4：skillRegistry（全局 + 项目级 skill 缓存，带 watcher）。landing 全局 skill 经此拿 globalCache（FR-5）。 */
  skillRegistry: SkillRegistry
  projectRoot: string
  /** wave 远程分享：token 管理器（config.getConnectionInfo 读当前 token）。 */
  tokenManager: TokenManager
  /** wave 远程分享：监听 bind host（config.getConnectionInfo 上下文用）。 */
  bindHost: string
  /** wave 远程分享：监听端口（config.getConnectionInfo 探测可达 URL 用）。 */
  port: number
  nextPushId(): string
  broadcast(msg: import('@xyz-agent/shared').ServerMessage): void
  broadcastProviderList(): void
  broadcastSkillList(): void
  broadcastSkillCacheInvalidated(scope: SkillCacheScope, cwd?: string): void
  broadcastAgentList(): void
  broadcastSkillDirs(): void
  broadcastAgentDirs(): void
  broadcastExtensionDirs(): void
}

export class SettingsMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  async handleSettingsMessage(msg: ClientMessage, ws: WsType, _clientId?: string): Promise<boolean> {
    switch (msg.type) {
      case 'config.getProviders':
        // P6 D3：reply 携带 version（客户端首次拉取 / version_conflict 后刷新时缓存）。
        this.ctx.reply(ws, msg.id, 'config.providers', { providers: this.ctx.configService.listProviders(), version: this.ctx.configService.getConfigVersion() })
        return true
      case 'config.setProvider': {
        const { providerId, expectedVersion, ...data } = msg.payload
        try {
          const setResult = this.ctx.configService.setProvider(providerId, data as Parameters<IConfigService['setProvider']>[1], expectedVersion)
          // P6 D3：reply 携带 newVersion 让发起方更新本地缓存（避免下次 set 再拉一次 version）。
          this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId, newVersion: setResult.newVersion })
          // 广播 provider 列表 + version 给所有客户端（其他客户端需感知 version 变化刷新本地缓存）。
          this.ctx.broadcastProviderList()
          // 如果 fallback 修正了 defaultModel，广播到所有 panel
          if (setResult.newDefault) {
            this.ctx.broadcast({
              type: 'config.defaults',
              id: this.ctx.nextPushId(),
              payload: { defaultModel: `${setResult.newDefault.provider}/${setResult.newDefault.modelId}`, source: 'provider-updated' },
            })
          }
        } catch (e) {
          // P6 D3：VersionConflictError → reply error{code:'version_conflict', currentVersion}。
          // 客户端收到后重新拉 config.list 刷新本地 version + toast 提示用户重试。
          if (e instanceof VersionConflictError) {
            this.ctx.sendError(ws, 'version_conflict', e.message, msg.id, { currentVersion: e.currentVersion })
            return true
          }
          throw e
        }
        return true
      }
      case 'config.deleteProvider': {
        const { providerId, expectedVersion } = msg.payload
        try {
          const delResult = this.ctx.configService.deleteProvider(providerId, expectedVersion)
          this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId, deleted: true, newVersion: delResult.newVersion })
          this.ctx.broadcastProviderList()
          // 如果 fallback 修正了 defaultModel，广播到所有 panel
          if (delResult.newDefault) {
            this.ctx.broadcast({
              type: 'config.defaults',
              id: this.ctx.nextPushId(),
              payload: { defaultModel: `${delResult.newDefault.provider}/${delResult.newDefault.modelId}`, source: 'provider-deleted' },
            })
          }
        } catch (e) {
          if (e instanceof VersionConflictError) {
            this.ctx.sendError(ws, 'version_conflict', e.message, msg.id, { currentVersion: e.currentVersion })
            return true
          }
          throw e
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
      case 'config.scanSessionSkills': {
        // W2（cw-2026-07-21-scan-project-agents-skills）：按 session cwd 拉 project skill。
        // 与 config.scanSkills 区分：scanSkills 扫 sources 数组候选加入 discovery + 广播全局；
        // scanSessionSkills 扫某 cwd 的 .agents/skills + .xyz-agent/skills 已生效目录，不广播
        // （按需 RPC，避免污染全局 config.skills，前端 useProjectSkills 按 cwd key 独立缓存）。
        const skills = this.ctx.configService.loadSkills(msg.payload.cwd)
        this.ctx.reply(ws, msg.id, 'config.sessionSkills', { skills })
        return true
      }
      case 'config.getGlobalSkills': {
        // W4：返回 skillRegistry globalCache（启动期扫描 + watcher 自动刷新，同步读缓存零开销）。
        // landing 全局 skill 走此 RPC（FR-5：不再走 settingsStore.skills 配置态扫描）。
        const skills = this.ctx.skillRegistry.getGlobalSkills()
        this.ctx.reply(ws, msg.id, 'config.globalSkills', { skills })
        return true
      }
      case 'config.getProjectSkills': {
        // W4：按 cwd 拉项目 skill（skillRegistry projectCache，首次扫描 + 挂 watcher，命中缓存零开销）。
        // 与 config.scanSessionSkills 区分：getProjectSkills 走 skillRegistry（带缓存 + 文件监听 W1 单例），
        // scanSessionSkills 直接调 configService.loadSkills(cwd)（无缓存）。前端 useProjectSkills 已切到本 RPC。
        const skills = await this.ctx.skillRegistry.getProjectSkills(msg.payload.cwd)
        this.ctx.reply(ws, msg.id, 'config.projectSkills', { skills })
        return true
      }
      case 'config.setSkillDirs': {
        // ADR-0020 §1 目录级管道：覆盖 discovery.json.skillDirs（有序数组 = 优先级）
        this.ctx.configService.setSkillDirs(msg.payload.dirs)
        this.ctx.reply(ws, msg.id, 'config.skillDirs', { dirs: msg.payload.dirs.map((path) => ({ path, enabled: true })) })
        // 触发 SkillRegistry 重建（close 旧 watcher → 重扫 globalCache → 重挂 watcher 含新路径）+ 清 projectCache。
        // rebuildGlobal 内部 notifyGlobalChange → onChange → 广播 config.skillCacheInvalidated('global') + reloadOrchestrator。
        // 显式广播 ('project')——让前端 useProjectSkills 也失效重拉。
        //
        // Promise 链语义（W1 修正：原 `.then` 内 invalidate+broadcast 在 rebuild reject 时被整段跳过，
        // 与下方「失败不阻塞后续 invalidate/broadcast」注释不符——原写法 broadcast 在 `.then` 里，
        // reject 时前端收不到 project 失效信号、useProjectSkills 仍展示陈旧缓存）：
        //   - 成功：invalidateAllProjects（清 projectCache，globalCache 已由 rebuild 重扫）+ broadcast('project')
        //   - 失败：仅 broadcast('project')（让前端至少重拉一次；projectCache 暂不清——rebuild 失败时
        //     globalCache 可能损坏，invalidateAllProjects 此时意义不大且 reloadOrchestrator 可能已在处理错误，
        //     等下次成功 rebuild 再清；用户重试 settings 操作可恢复）。
        // broadcast 总是执行（无论 rebuild 成败都通知前端 project 失效），invalidate 只在成功时。
        // best-effort：失败只记日志，不阻塞 WS 消息处理（reply/broadcastSkillDirs 已立即返回）。
        void this.ctx.skillRegistry.rebuildGlobal()
          .then(() => {
            this.ctx.skillRegistry.invalidateAllProjects()
            this.ctx.broadcastSkillCacheInvalidated('project')
          })
          .catch((e: unknown) => {
            console.error('[settings-handler] skillRegistry.rebuildGlobal failed after setSkillDirs:', e)
            // rebuild 失败也广播失效，让前端至少重拉一次（projectCache 未清，前端拉到旧值——
            // 但比完全不通知好，用户重试 settings 操作可恢复）。
            this.ctx.broadcastSkillCacheInvalidated('project')
          })
        this.ctx.broadcastSkillDirs()
        this.ctx.broadcastSkillList()
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
      case 'config.detectSources': {
        // W1 迁移功能：检测本机其他 agent（Claude/Codex/Pi/ZCode）的 skill/agent 配置目录。
        // 只读检测（不读文件内容），reply 检测结果数组。无副作用，无需广播。
        const sources = this.ctx.configService.detectSources()
        this.ctx.reply(ws, msg.id, 'config.sourcesDetected', { sources })
        return true
      }
      case 'config.previewImportProviders': {
        // W2 迁移：Step1 预览从其他 agent 源导入的 provider 列表（脱敏，apiKey 不进前端）。
        // result 可能是 { importId, preview }（成功）或 { error }（源未安装等），reply 原样转发。
        // 前端按有无 error 字段判断成败。无广播（按需 RPC，apply 后才广播 provider 列表）。
        // W1：payload 字段校验——source 必须是已知 ProviderSource，否则 sendError。
        const source = msg.payload?.source
        const VALID_SOURCES: ProviderSource[] = ['pi', 'zcode', 'codex', 'claude']
        if (typeof source !== 'string' || !VALID_SOURCES.includes(source as ProviderSource)) {
          this.ctx.sendError(ws, 'invalid_payload', 'config.previewImportProviders requires a valid "source" (pi|zcode|codex|claude)', msg.id)
          return true
        }
        const result = this.ctx.configService.previewImportProviders(source as ProviderSource)
        this.ctx.reply(ws, msg.id, 'config.providersPreviewed', result)
        return true
      }
      case 'config.applyImportProviders': {
        // W2 迁移：Step2 应用导入（写 models.json）。result 可能是 { result }（成功）或 { error }（缓存过期等）。
        // apply 成功后广播 provider 列表（与 setProvider/deleteProvider 对称，让所有 panel 同步新增的 provider）。
        // W1：payload 字段校验——importId 必须是字符串，selectedIds 必须是字符串数组，否则 sendError。
        const importId = msg.payload?.importId
        const selectedIds = msg.payload?.selectedIds
        if (typeof importId !== 'string' || !importId.trim() ||
            !Array.isArray(selectedIds) || !selectedIds.every((id: unknown) => typeof id === 'string')) {
          this.ctx.sendError(ws, 'invalid_payload', 'config.applyImportProviders requires a non-empty "importId" string and "selectedIds" string array', msg.id)
          return true
        }
        const result = this.ctx.configService.applyImportProviders(importId, selectedIds as string[])
        this.ctx.reply(ws, msg.id, 'config.providersImported', result)
        // 仅成功时广播（result 有 result 字段 = 成功；有 error 字段 = 失败，不广播）
        if ('result' in result) {
          this.ctx.broadcastProviderList()
        }
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
      case 'config.setExtensionDirs': {
        // ADR-0020 §1 目录级管道：覆盖 discovery.json.extensionDirs（有序数组 = 优先级）
        this.ctx.configService.setExtensionDirs(msg.payload.dirs)
        this.ctx.reply(ws, msg.id, 'config.extensionDirs', { dirs: msg.payload.dirs.map((path) => ({ path, enabled: true })) })
        this.ctx.broadcastExtensionDirs()
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
      case 'config.getTerminalConfig': {
        // Phase 6：读取 terminal 配置。corrupted 透传给前端（提示用户文件已损坏并重置）。
        const result = this.ctx.configService.getTerminalConfig()
        this.ctx.reply(ws, msg.id, 'config.terminalConfig', {
          config: result.config,
          corrupted: result.corrupted,
        })
        return true
      }
      case 'config.setTerminalConfig': {
        // Phase 6：写入 terminal 配置。失败（超范围等）按 D10 错误信封回复，不广播；
        // 成功 reply + 广播 config.terminalConfig（corrupted=false）让所有 panel 同步。
        const { config } = msg.payload
        const result = this.ctx.configService.setTerminalConfig(config)
        if (!result.ok) {
          this.ctx.sendError(ws, 'set_terminal_config_failed', result.error ?? 'unknown error', msg.id)
          return true
        }
        this.ctx.reply(ws, msg.id, 'config.terminalConfig', { config, corrupted: false })
        this.ctx.broadcast({
          type: 'config.terminalConfig',
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
      case 'config.setWorktreeRootDir': {
        this.ctx.configService.setWorktreeRootDir(msg.payload.dir)
        this.ctx.reply(ws, msg.id, 'config.worktreeRootDir', { dir: this.ctx.configService.getWorktreeRootDir() })
        return true
      }
      case 'config.getWorktreeRootDir': {
        this.ctx.reply(ws, msg.id, 'config.worktreeRootDir', { dir: this.ctx.configService.getWorktreeRootDir() })
        return true
      }
      case 'config.setSetupScript': {
        this.ctx.configService.setSetupScript(msg.payload.script)
        this.ctx.reply(ws, msg.id, 'config.setupScript', { script: this.ctx.configService.getSetupScript() })
        return true
      }
      case 'config.getSetupScript': {
        this.ctx.reply(ws, msg.id, 'config.setupScript', { script: this.ctx.configService.getSetupScript() })
        return true
      }
      case 'config.setBareSetupScript': {
        this.ctx.configService.setBareSetupScript(msg.payload.script)
        this.ctx.reply(ws, msg.id, 'config.bareSetupScript', { script: this.ctx.configService.getBareSetupScript() })
        return true
      }
      case 'config.getBareSetupScript': {
        this.ctx.reply(ws, msg.id, 'config.bareSetupScript', { script: this.ctx.configService.getBareSetupScript() })
        return true
      }
      case 'config.setTimeout': {
        this.ctx.configService.setTimeout(msg.payload.timeout)
        this.ctx.reply(ws, msg.id, 'config.worktreeTimeout', { timeout: this.ctx.configService.getTimeout() })
        return true
      }
      case 'config.getTimeout': {
        this.ctx.reply(ws, msg.id, 'config.worktreeTimeout', { timeout: this.ctx.configService.getTimeout() })
        return true
      }
      case 'config.setDefaultBaseBranch': {
        this.ctx.configService.setDefaultBaseBranch(msg.payload.baseBranch)
        this.ctx.reply(ws, msg.id, 'config.defaultBaseBranch', { baseBranch: this.ctx.configService.getDefaultBaseBranch() })
        return true
      }
      case 'config.getDefaultBaseBranch': {
        this.ctx.reply(ws, msg.id, 'config.defaultBaseBranch', { baseBranch: this.ctx.configService.getDefaultBaseBranch() })
        return true
      }
      case 'config.setAutoRenameEnabled': {
        this.ctx.configService.setAutoRenameEnabled(msg.payload.enabled)
        this.ctx.reply(ws, msg.id, 'config.autoRenameEnabled', { enabled: this.ctx.configService.getAutoRenameEnabled() })
        return true
      }
      case 'config.getAutoRenameEnabled': {
        this.ctx.reply(ws, msg.id, 'config.autoRenameEnabled', { enabled: this.ctx.configService.getAutoRenameEnabled() })
        return true
      }
      case 'config.getConnectionInfo': {
        // wave 远程分享：探测可达地址 + 当前 token，供设置面板展示分享链接。
        // detectUrls 是 best-effort（探测失败兜底 localhost），不抛错；token 开放模式时为空串。
        const detected = await detectUrls(this.ctx.port)
        const loaded = this.ctx.tokenManager.load()
        const token = loaded.enabled ? loaded.token : ''
        this.ctx.reply(ws, msg.id, 'config.connectionInfo', { token, urls: detected })
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
