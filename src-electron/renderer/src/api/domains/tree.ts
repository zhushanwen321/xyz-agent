import type { ClientMessage, ClientMessageMap } from '@xyz-agent/shared'

type Command = <T = unknown>(msg: ClientMessage) => Promise<T>

export interface TreeDomain {
  data: (payload: ClientMessageMap['session.tree-data']) => Promise<unknown>
  navigate: (payload: ClientMessageMap['session.tree-navigate']) => Promise<unknown>
  fork: (payload: ClientMessageMap['session.tree-fork']) => Promise<unknown>
  clone: (payload: ClientMessageMap['session.tree-clone']) => Promise<unknown>
  capability: (payload: ClientMessageMap['session.tree-capability']) => Promise<unknown>
}

export const treeApi = (command: Command): TreeDomain => ({
  data: (payload) => command({ type: 'session.tree-data', payload }),
  navigate: (payload) => command({ type: 'session.tree-navigate', payload }),
  fork: (payload) => command({ type: 'session.tree-fork', payload }),
  clone: (payload) => command({ type: 'session.tree-clone', payload }),
  capability: (payload) => command({ type: 'session.tree-capability', payload }),
})
