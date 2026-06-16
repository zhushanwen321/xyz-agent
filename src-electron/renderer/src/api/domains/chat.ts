import type { ClientMessage, ClientMessageMap } from '@xyz-agent/shared'

type Command = <T = unknown>(msg: ClientMessage) => Promise<T>

export interface ChatDomain {
  send: (payload: ClientMessageMap['message.send']) => Promise<unknown>
  abort: (payload: ClientMessageMap['message.abort']) => Promise<unknown>
  steer: (payload: ClientMessageMap['message.steer']) => Promise<unknown>
  followUp: (payload: ClientMessageMap['message.follow_up']) => Promise<unknown>
}

export const chatApi = (command: Command): ChatDomain => ({
  send: (payload) => command({ type: 'message.send', payload }),
  abort: (payload) => command({ type: 'message.abort', payload }),
  steer: (payload) => command({ type: 'message.steer', payload }),
  followUp: (payload) => command({ type: 'message.follow_up', payload }),
})
