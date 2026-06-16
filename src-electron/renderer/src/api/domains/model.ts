import type { ClientMessage, ClientMessageMap } from '@xyz-agent/shared'

type Command = <T = unknown>(msg: ClientMessage) => Promise<T>

export interface ModelDomain {
  list: () => Promise<unknown>
  switch: (payload: ClientMessageMap['model.switch']) => Promise<unknown>
}

export const modelApi = (command: Command): ModelDomain => ({
  list: () => command({ type: 'model.list', payload: {} }),
  switch: (payload) => command({ type: 'model.switch', payload }),
})
