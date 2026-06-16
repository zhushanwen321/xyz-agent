import type { ClientMessage, ClientMessageMap } from '@xyz-agent/shared'

type Command = <T = unknown>(msg: ClientMessage) => Promise<T>

export interface ExtensionDomain {
  uiResponse: (payload: ClientMessageMap['extension.ui_response']) => Promise<unknown>
  toggle: (payload: ClientMessageMap['extension.toggle']) => Promise<unknown>
  list: () => Promise<unknown>
  install: (payload: ClientMessageMap['extension.install']) => Promise<unknown>
  uninstall: (payload: ClientMessageMap['extension.uninstall']) => Promise<unknown>
  installDir: (payload: ClientMessageMap['extension.installDir']) => Promise<unknown>
  installGit: (payload: ClientMessageMap['extension.installGit']) => Promise<unknown>
  finishInstall: (payload: ClientMessageMap['extension.finishInstall']) => Promise<unknown>
  cancelInstall: (payload: ClientMessageMap['extension.cancelInstall']) => Promise<unknown>
}

export const extensionApi = (command: Command): ExtensionDomain => ({
  uiResponse: (payload) => command({ type: 'extension.ui_response', payload }),
  toggle: (payload) => command({ type: 'extension.toggle', payload }),
  list: () => command({ type: 'extension.list', payload: {} }),
  install: (payload) => command({ type: 'extension.install', payload }),
  uninstall: (payload) => command({ type: 'extension.uninstall', payload }),
  installDir: (payload) => command({ type: 'extension.installDir', payload }),
  installGit: (payload) => command({ type: 'extension.installGit', payload }),
  finishInstall: (payload) => command({ type: 'extension.finishInstall', payload }),
  cancelInstall: (payload) => command({ type: 'extension.cancelInstall', payload }),
})
