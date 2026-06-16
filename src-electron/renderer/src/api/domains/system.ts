import type { ClientMessage, ClientMessageMap } from '@xyz-agent/shared'

type Command = <T = unknown>(msg: ClientMessage) => Promise<T>

export interface SystemDomain {
  ping: () => Promise<unknown>
  readFile: (payload: ClientMessageMap['file.read']) => Promise<unknown>
}

export const systemApi = (command: Command): SystemDomain => ({
  ping: () => command({ type: 'ping', payload: {} }),
  readFile: (payload) => command({ type: 'file.read', payload }),
})
