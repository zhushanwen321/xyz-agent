// Client → Sidecar message types
export type ClientMessageType =
  | 'session.create' | 'session.delete' | 'session.list' | 'session.switch' | 'session.history'
  | 'session.compact' | 'session.clear' | 'session.restore' | 'session.rename'
  | 'message.send' | 'message.abort'
  | 'config.getProviders' | 'config.setProvider' | 'config.deleteProvider' | 'config.setToolPermissions'
  | 'config.discoverModels'
  | 'config.scanSkills' | 'config.setSkill' | 'config.deleteSkill'
  | 'config.scanAgents' | 'config.setAgent' | 'config.deleteAgent'
  | 'model.list' | 'model.switch'
  | 'tool.approve' | 'tool.deny' | 'tool.always_allow'
  | 'ping'
  | 'session.tree-data' | 'session.tree-navigate' | 'session.tree-fork' | 'session.tree-clone' | 'session.tree-capability'

export interface ClientMessage {
  type: ClientMessageType
  id?: string
  payload: Record<string, unknown>
}

// Sidecar → Client message types
export type ServerMessageType =
  | 'session.created' | 'session.deleted' | 'session.list' | 'session.history'
  | 'session.compacting' | 'session.compacted' | 'session.restored' | 'session.renamed'
  | 'message.message_start' | 'message.text_delta' | 'message.thinking_delta'
  | 'message.thinking_start' | 'message.thinking_end'
  | 'message.tool_call_start' | 'message.tool_call_end' | 'message.tool_call_pending'
  | 'message.complete' | 'message.error' | 'message.status'
  | 'context.update'
  | 'config.providers' | 'config.providerUpdated' | 'config.discoveredModels'
  | 'config.scannedSkills' | 'config.skillUpdated' | 'config.skillDeleted'
  | 'config.scannedAgents' | 'config.agentUpdated' | 'config.agentDeleted'
  | 'config.skills' | 'config.agents'
  | 'model.list' | 'model.switched'
  | 'pong' | 'error'
  | 'session.commands'
  | 'session.tree-data' | 'session.tree-navigate-result' | 'session.tree-fork-result' | 'session.tree-clone-result' | 'session.tree-capability'

export interface ServerMessage {
  type: ServerMessageType
  id?: string
  payload: Record<string, unknown>
}
