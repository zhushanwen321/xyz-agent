import type { ClientMessage, ClientMessageMap } from '@xyz-agent/shared'

type Command = <T = unknown>(msg: ClientMessage) => Promise<T>

export interface ConfigDomain {
  getProviders: () => Promise<unknown>
  setProvider: (payload: ClientMessageMap['config.setProvider']) => Promise<unknown>
  deleteProvider: (payload: ClientMessageMap['config.deleteProvider']) => Promise<unknown>
  setToolPermissions: (payload: ClientMessageMap['config.setToolPermissions']) => Promise<unknown>
  discoverModels: (payload: ClientMessageMap['config.discoverModels']) => Promise<unknown>
  scanSkills: (payload: ClientMessageMap['config.scanSkills']) => Promise<unknown>
  setSkill: (payload: ClientMessageMap['config.setSkill']) => Promise<unknown>
  deleteSkill: (payload: ClientMessageMap['config.deleteSkill']) => Promise<unknown>
  scanAgents: (payload: ClientMessageMap['config.scanAgents']) => Promise<unknown>
  setAgent: (payload: ClientMessageMap['config.setAgent']) => Promise<unknown>
  deleteAgent: (payload: ClientMessageMap['config.deleteAgent']) => Promise<unknown>
}

export const configApi = (command: Command): ConfigDomain => ({
  getProviders: () => command({ type: 'config.getProviders', payload: {} }),
  setProvider: (payload) => command({ type: 'config.setProvider', payload }),
  deleteProvider: (payload) => command({ type: 'config.deleteProvider', payload }),
  setToolPermissions: (payload) => command({ type: 'config.setToolPermissions', payload }),
  discoverModels: (payload) => command({ type: 'config.discoverModels', payload }),
  scanSkills: (payload) => command({ type: 'config.scanSkills', payload }),
  setSkill: (payload) => command({ type: 'config.setSkill', payload }),
  deleteSkill: (payload) => command({ type: 'config.deleteSkill', payload }),
  scanAgents: (payload) => command({ type: 'config.scanAgents', payload }),
  setAgent: (payload) => command({ type: 'config.setAgent', payload }),
  deleteAgent: (payload) => command({ type: 'config.deleteAgent', payload }),
})
