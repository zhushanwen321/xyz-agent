import type { ClientMessage, ServerMessage, ServerMessageType } from '@xyz-agent/shared'
import { send } from '../lib/ws-client'
import { on } from '../lib/event-bus'

/** 传输层抽象：抹平 ws send/recv 与未来 ipc 差异，向上只暴露「发消息 + 订阅消息/关闭」。 */
export interface Transport {
  send(msg: ClientMessage): void
  onMessage(handler: (msg: ServerMessage) => void): () => void
  onClose(handler: (reason: string) => void): () => void
}

/** 注入式依赖：sendRaw 负责把已序列化的字符串投递到底层通道；subscribe 一次注册消息+关闭两类回调。 */
export interface TransportDeps {
  sendRaw: (raw: string) => void
  subscribe: (
    onMsg: (msg: ServerMessage) => void,
    onClose: (reason: string) => void,
  ) => () => void
}

export function createTransport(deps: TransportDeps): Transport {
  return {
    send: (msg) => deps.sendRaw(JSON.stringify(msg)),
    onMessage: (handler) => deps.subscribe(handler, () => {}),
    onClose: (handler) => deps.subscribe(() => {}, handler),
  }
}

// ponytail: 过渡常量——event-bus 按 ServerMessageType 分发、无通配订阅，
// 要收全部 ServerMessage 只能遍历类型。此数组镜像 shared/protocol.ts 的 ServerMessageType，
// 约束禁止改 shared 故就地维护。SA6 切断 event-bus 直连 ws 后连同本工厂一并删除。
const SERVER_TYPES: readonly ServerMessageType[] = [
  'session.created', 'session.deleted', 'session.list', 'session.history',
  'session.compacting', 'session.compacted', 'session.renamed',
  'session.thinkingLevelSet', 'session.commands',
  'session.tree-data', 'session.tree-navigate-result', 'session.tree-fork-result',
  'session.tree-clone-result', 'session.tree-capability',
  'message.message_start', 'message.text_delta', 'message.thinking_delta',
  'message.thinking_start', 'message.thinking_end',
  'message.tool_call_start', 'message.tool_call_end', 'message.tool_call_pending',
  'message.tool_call_update', 'message.complete', 'message.error', 'message.status',
  'message.bashExecution', 'message.compactionSummary', 'message.branchSummary',
  'message.auto_retry_start', 'message.auto_retry_end',
  'message.queue_update', 'message.stream_error',
  'context.update',
  'config.providers', 'config.providerUpdated', 'config.discoveredModels', 'config.defaults',
  'config.scannedSkills', 'config.skillUpdated', 'config.skillDeleted',
  'config.scannedAgents', 'config.agentUpdated', 'config.agentDeleted',
  'config.skills', 'config.agents', 'config.extensions', 'config.plugins',
  'model.list', 'model.switched',
  'pong', 'error',
  'extension.ui_request', 'extension.ui_timeout', 'extension.error',
  'extension.discovered', 'extension.installError', 'extension.installCancelled',
  'extension:widget', 'extension:status', 'extension:setEditorText',
  'plugin:crashed', 'plugin:notification', 'plugin:statusChange',
  'plugin:permissionRequest', 'plugin:statusBarUpdate', 'plugin:messageDecoration',
  'plugin:config', 'plugin:statusSetUpdate', 'plugin:uiRequest',
  'file.read:result', 'file.read:error',
]

/**
 * 过渡装配：基于现有 event-bus + ws-client，让新旧并存。
 * - sendRaw：ws-client.send 已含序列化，此处 parse 回对象以适配 sendRaw(raw) 契约（双序列化代价可接受，过渡期）。
 * - onMsg：遍历 SERVER_TYPES 订阅 event-bus，把每条 ServerMessage 透传给 handler。
 * - onClose：ws-client 不 emit 连接事件，过渡期无信号；SA6 直连 ws 后由 ws.onclose 驱动。
 */
export function createEventBusTransport(): Transport {
  return createTransport({
    sendRaw: (raw) => send(JSON.parse(raw) as ClientMessage),
    subscribe: (onMsg) => {
      const offs = SERVER_TYPES.map((t) => on(t, (msg) => onMsg(msg)))
      return () => offs.forEach((off) => off())
    },
  })
}
