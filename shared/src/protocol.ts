// Client → Sidecar message types
export type ClientMessageType =
  | 'session.create' | 'session.delete' | 'session.list' | 'session.switch' | 'session.history'
  | 'session.compact' | 'session.clear'
  | 'message.send' | 'message.abort'
  | 'config.getProviders' | 'config.setProvider' | 'config.deleteProvider' | 'config.setToolPermissions'
  | 'model.list' | 'model.switch'
  | 'tool.approve' | 'tool.deny' | 'tool.always_allow'
  | 'ping'

export interface ClientMessage {
  type: ClientMessageType
  id?: string
  payload: Record<string, unknown>
}

// Sidecar → Client message types
export type ServerMessageType =
  | 'session.created' | 'session.deleted' | 'session.list' | 'session.history'
  | 'session.compacting'
  | 'message.text_delta' | 'message.thinking_delta'
  | 'message.thinking_start' | 'message.thinking_end'
  | 'message.tool_call_start' | 'message.tool_call_end' | 'message.tool_call_pending'
  | 'message.complete' | 'message.error' | 'message.status'
  | 'context.update'
  | 'config.providers' | 'config.providerUpdated'
  | 'model.list' | 'model.switched'
  | 'pong' | 'error'

export interface ServerMessage {
  type: ServerMessageType
  id?: string
  payload: Record<string, unknown>
}
