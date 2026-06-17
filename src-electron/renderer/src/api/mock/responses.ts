/* eslint-disable no-magic-numbers */
/**
 * Mock 响应表：ClientMessage → ServerMessage[]（SA3 / D8）。
 *
 * 约定（mock-transport 依赖）：
 * - 数组首条通常是「命令响应」：type 对应、`id` 回填请求 id → pending 结算。
 * - 其余为「事件推送」：无 id，走 events 路径。
 * - message.send 的首条（message_start 带 id）立即发，其余延迟发（打字机效果，见 mock-transport）。
 *
 * 复用 mock/data.ts 的预制数据；payload 形状贴近旧 mock-ws.ts 以减少 UI 回归。
 */
import type { ClientMessage, ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import {
  mockSessionGroups, mockMessages, mockProviders, mockModels,
  mockSkills, mockAgents, DEFAULT_SESSION_ID, toModelInfos, mockSubAgentTree,
} from '../../mock/data'

/** 命令响应：回填请求 id（pending 靠 id 结算，缺失则 30s 超时）。 */
const reply = (
  msg: ClientMessage,
  type: ServerMessageType,
  payload: Record<string, unknown>,
): ServerMessage => ({ type, id: msg.id, payload })

/** 事件推送：无 id（走 events 路径，订阅方按 type 消费）。 */
const evt = (
  type: ServerMessageType,
  payload: Record<string, unknown>,
): ServerMessage => ({ type, payload })

/** 默认 ack：无明确响应类型的命令统一回 pong（带 id），保证 pending 不超时。 */
const ack = (msg: ClientMessage): ServerMessage => reply(msg, 'pong', {})

const providerList = () => mockProviders.map(p => ({
  id: p.id, name: p.name, api: p.api, status: p.status,
  models: p.models, apiKeySet: p.apiKeySet, baseUrl: p.baseUrl, enabled: p.enabled,
}))

const skillList = () => mockSkills.map(s => ({
  id: s.name, name: s.name, description: s.description, enabled: s.enabled,
  source: s.source, triggers: s.triggers, sourcePath: s.sourcePath,
  sourceIcon: s.sourceIcon, fileSize: s.fileSize, tools: s.tools, content: s.content, tag: s.tag,
}))

const agentList = () => mockAgents.map(a => ({
  id: a.name, name: a.name, description: a.description, enabled: a.active,
  modelStrategy: a.modelStrategy ?? 'default', icon: a.icon, source: a.source,
  sourceType: a.sourceType, iconBg: a.iconBg, type: a.type, tools: a.tools,
  modelBind: a.modelBind, modelTags: a.modelTags, overrideParams: a.overrideParams,
  params: a.params, content: a.content,
}))

const HISTORY_DELAYED_MODELS: Record<string, Array<{ id: string; name: string; ctx?: number }>> = {
  'anthropic-messages': [
    { id: 'claude-sonnet-4', name: 'claude-sonnet-4', ctx: 200000 },
    { id: 'claude-opus-4', name: 'claude-opus-4', ctx: 200000 },
    { id: 'claude-haiku-4', name: 'claude-haiku-4', ctx: 200000 },
  ],
  'openai-completions': [
    { id: 'gpt-4o', name: 'gpt-4o', ctx: 128000 },
    { id: 'gpt-4o-mini', name: 'gpt-4o-mini', ctx: 128000 },
    { id: 'o3', name: 'o3', ctx: 200000 },
    { id: 'deepseek-v4', name: 'deepseek-v4', ctx: 1000000 },
    { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', ctx: 1000000 },
  ],
}

/**
 * 按消息 type 构造响应序列。返回空数组表示不 emit（极少见，目前所有 type 都至少 ack）。
 */
export function getMockResponse(msg: ClientMessage): ServerMessage[] {
  switch (msg.type) {
    // ── system ──
    case 'ping':
      return [reply(msg, 'pong', {})]
    case 'file.read':
      return [reply(msg, 'file.read:result', { path: msg.payload.path, content: '' })]

    // ── session ──
    case 'session.create':
      return [reply(msg, 'session.created', {
        session: {
          id: 'mock-new-' + Date.now(),
          label: msg.payload.label || '新会话',
          cwd: msg.payload.cwd || '/Users/mock/project',
          status: 'idle',
          lastActiveAt: Date.now(),
          modelId: 'claude-sonnet',
          tokenCount: 0,
        },
      })]
    case 'session.list':
      return [reply(msg, 'session.list', { groups: mockSessionGroups })]
    case 'session.switch': {
      // 命令响应走 session.list（带 id 结算）；history 作为事件推送（订阅方更新消息流）
      const sid = msg.payload.sessionId || DEFAULT_SESSION_ID
      return [
        reply(msg, 'session.list', { groups: mockSessionGroups }),
        evt('session.history', { sessionId: sid, messages: mockMessages }),
      ]
    }
    case 'session.history':
      return [reply(msg, 'session.history', {
        sessionId: msg.payload.sessionId || DEFAULT_SESSION_ID,
        messages: mockMessages,
      })]
    case 'session.compact':
      return [
        reply(msg, 'session.compacting', { sessionId: msg.payload.sessionId, status: 'compacting' }),
        evt('session.compacted', { sessionId: msg.payload.sessionId, status: 'compacted' }),
      ]
    case 'session.rename':
      return [reply(msg, 'session.renamed', { sessionId: msg.payload.sessionId, name: msg.payload.name })]
    case 'session.delete': {
      const delId = msg.payload.sessionId
      for (const group of mockSessionGroups) {
        const idx = group.sessions.findIndex(s => s.id === delId)
        if (idx >= 0) { group.sessions.splice(idx, 1); break }
      }
      return [
        reply(msg, 'session.deleted', { sessionId: delId }),
        evt('session.list', { groups: mockSessionGroups }),
      ]
    }
    case 'session.setThinkingLevel':
      return [reply(msg, 'session.thinkingLevelSet', {
        sessionId: msg.payload.sessionId, level: msg.payload.level,
      })]

    // ── session tree ──
    case 'session.tree-data':
      return [reply(msg, 'session.tree-data', {
        sessionId: msg.payload.sessionId, tree: mockSubAgentTree,
      })]
    case 'session.tree-navigate':
      return [reply(msg, 'session.tree-navigate-result', {
        sessionId: msg.payload.sessionId, targetEntryId: msg.payload.targetEntryId, success: true,
      })]
    case 'session.tree-fork':
      return [reply(msg, 'session.tree-fork-result', {
        sessionId: msg.payload.sessionId, entryId: msg.payload.entryId, success: true,
      })]
    case 'session.tree-clone':
      return [reply(msg, 'session.tree-clone-result', { sessionId: msg.payload.sessionId, success: true })]
    case 'session.tree-capability':
      return [reply(msg, 'session.tree-capability', { sessionId: msg.payload.sessionId, capability: {} })]

    // ── message ──
    case 'message.send': {
      const { sessionId, content } = msg.payload
      return [
        // 命令响应 message.status（带 id，pending 结算）；与 runtime session-message-handler 对齐
        reply(msg, 'message.status', { sessionId, status: 'sent' }),
        // 流式事件（无 id，走 events 广播，onMessage 路由触发 onMessageStart）
        evt('message.message_start', { sessionId }),
        evt('message.thinking_start', { sessionId }),
        evt('message.thinking_delta', { sessionId, delta: '分析用户请求...' }),
        evt('message.thinking_end', { sessionId, content: '分析用户请求...' }),
        evt('message.text_delta', {
          sessionId,
          delta: `收到：「${content.slice(0, 20)}...」。这是 mock 响应。`,
        }),
        evt('message.complete', { sessionId }),
      ]
    }
    case 'message.abort':
      return [reply(msg, 'message.complete', { sessionId: msg.payload.sessionId, stopReason: 'aborted' })]
    case 'message.steer':
    case 'message.follow_up':
      // 与 runtime session-message-handler 对齐：steer→status:steered, follow_up→status:queued（带 id 命令响应）
      return [reply(msg, 'message.status', { sessionId: msg.payload.sessionId, status: msg.type === 'message.steer' ? 'steered' : 'queued' })]

    // ── config ──
    case 'config.getProviders':
      return [reply(msg, 'config.providers', { providers: providerList() })]
    case 'config.setProvider': {
      const { providerId, name, type, baseUrl, apiKey, models, enabled } = msg.payload
      if (providerId && name) {
        const existing = mockProviders.find(p => p.id === providerId)
        if (existing) {
          existing.name = name
          if (type) existing.api = type
          if (baseUrl !== undefined) existing.baseUrl = baseUrl
          if (apiKey && apiKey !== '••••••••') existing.apiKeySet = true
          if (Array.isArray(models)) existing.models = models as typeof existing.models
        } else {
          mockProviders.push({
            id: providerId, name, api: type ?? 'openai-completions',
            status: 'not_configured',
            models: Array.isArray(models) ? models as typeof mockProviders[0]['models'] : [],
            apiKeySet: !!apiKey && apiKey !== '••••••••',
            baseUrl: baseUrl ?? '', icon: name.charAt(0).toUpperCase(),
          })
        }
      } else if (providerId && enabled !== undefined) {
        const target = mockProviders.find(p => p.id === providerId)
        if (target) target.enabled = !target.enabled
      }
      return [
        reply(msg, 'config.providerUpdated', { providerId }),
        evt('config.providers', { providers: providerList() }),
      ]
    }
    case 'config.deleteProvider': {
      const delId = msg.payload.providerId
      if (delId) {
        const idx = mockProviders.findIndex(p => p.id === delId)
        if (idx >= 0) mockProviders.splice(idx, 1)
      }
      return [
        reply(msg, 'config.providerUpdated', { providerId: delId }),
        evt('config.providers', { providers: providerList() }),
      ]
    }
    case 'config.discoverModels': {
      const models = HISTORY_DELAYED_MODELS[msg.payload.providerType ?? ''] ?? []
      return [reply(msg, 'config.discoveredModels', { models, success: true })]
    }
    case 'config.scanSkills':
      return [reply(msg, 'config.scannedSkills', { sources: msg.payload.sources, skills: skillList() })]
    case 'config.setSkill':
      return [reply(msg, 'config.skillUpdated', { skill: msg.payload.skill })]
    case 'config.deleteSkill':
      return [reply(msg, 'config.skillDeleted', { skillId: msg.payload.skillId })]
    case 'config.scanAgents':
      return [reply(msg, 'config.scannedAgents', { sources: msg.payload.sources, agents: agentList() })]
    case 'config.setAgent':
      return [reply(msg, 'config.agentUpdated', { agent: msg.payload.agent })]
    case 'config.deleteAgent':
      return [reply(msg, 'config.agentDeleted', { agentId: msg.payload.agentId })]
    case 'config.setToolPermissions':
      return [ack(msg)]

    // ── model ──
    case 'model.list':
      return [reply(msg, 'model.list', { models: toModelInfos(mockModels) })]
    case 'model.switch':
      return [reply(msg, 'model.switched', {
        sessionId: msg.payload.sessionId, modelId: msg.payload.modelId,
      })]

    // ── extension ──
    case 'extension.list':
      return [reply(msg, 'config.extensions', { extensions: [] })]
    case 'extension.ui_response':
    case 'extension.toggle':
    case 'extension.install':
    case 'extension.uninstall':
    case 'extension.installDir':
    case 'extension.installGit':
    case 'extension.finishInstall':
    case 'extension.cancelInstall':
      return [ack(msg)]

    // ── plugin ──
    case 'plugin.list':
      return [reply(msg, 'config.plugins', { plugins: [] })]
    case 'plugin.config.get':
      return [reply(msg, 'plugin:config', { pluginId: msg.payload.pluginId, config: {} })]
    case 'plugin.toggle':
    case 'plugin.install':
    case 'plugin.uninstall':
    case 'plugin.approvePermissions':
    case 'plugin.revokePermissions':
    case 'plugin.executeCommand':
    case 'plugin.config.set':
    case 'plugin.uiResponse':
      return [ack(msg)]

    // ── tool ──
    case 'tool.approve':
    case 'tool.deny':
    case 'tool.always_allow':
      return [ack(msg)]

    default: {
      // 穷尽性兜底：ClientMessageType 新增型未覆盖时 warn + ack，避免 pending 挂死
      const t = (msg as { type: string }).type
      console.warn('[mock-transport] unhandled type, falling back to pong:', t)
      return [ack(msg)]
    }
  }
}
