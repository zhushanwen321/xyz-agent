import type { ClientMessage, ClientMessageMap } from '@xyz-agent/shared'

type Command = <T = unknown>(msg: ClientMessage) => Promise<T>

export interface PluginDomain {
  list: () => Promise<unknown>
  toggle: (payload: ClientMessageMap['plugin.toggle']) => Promise<unknown>
  install: (payload: ClientMessageMap['plugin.install']) => Promise<unknown>
  uninstall: (payload: ClientMessageMap['plugin.uninstall']) => Promise<unknown>
  approvePermissions: (payload: ClientMessageMap['plugin.approvePermissions']) => Promise<unknown>
  revokePermissions: (payload: ClientMessageMap['plugin.revokePermissions']) => Promise<unknown>
  executeCommand: (payload: ClientMessageMap['plugin.executeCommand']) => Promise<unknown>
  configGet: (payload: ClientMessageMap['plugin.config.get']) => Promise<unknown>
  configSet: (payload: ClientMessageMap['plugin.config.set']) => Promise<unknown>
  uiResponse: (payload: ClientMessageMap['plugin.uiResponse']) => Promise<unknown>
}

export const pluginApi = (command: Command): PluginDomain => ({
  list: () => command({ type: 'plugin.list', payload: {} }),
  toggle: (payload) => command({ type: 'plugin.toggle', payload }),
  install: (payload) => command({ type: 'plugin.install', payload }),
  uninstall: (payload) => command({ type: 'plugin.uninstall', payload }),
  approvePermissions: (payload) => command({ type: 'plugin.approvePermissions', payload }),
  revokePermissions: (payload) => command({ type: 'plugin.revokePermissions', payload }),
  executeCommand: (payload) => command({ type: 'plugin.executeCommand', payload }),
  configGet: (payload) => command({ type: 'plugin.config.get', payload }),
  configSet: (payload) => command({ type: 'plugin.config.set', payload }),
  uiResponse: (payload) => command({ type: 'plugin.uiResponse', payload }),
})
