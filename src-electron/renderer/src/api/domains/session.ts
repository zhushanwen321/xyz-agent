import type { ClientMessage, ClientMessageMap } from '@xyz-agent/shared'

/** 命令发送器：发 ClientMessage 并等待 id 匹配的响应。T 默认 unknown，调用方按需断言 result。 */
type Command = <T = unknown>(msg: ClientMessage) => Promise<T>

export interface SessionDomain {
  create: (payload: ClientMessageMap['session.create']) => Promise<unknown>
  list: () => Promise<unknown>
  switch: (payload: ClientMessageMap['session.switch']) => Promise<unknown>
  history: (payload: ClientMessageMap['session.history']) => Promise<unknown>
  compact: (payload: ClientMessageMap['session.compact']) => Promise<unknown>
  rename: (payload: ClientMessageMap['session.rename']) => Promise<unknown>
  delete: (payload: ClientMessageMap['session.delete']) => Promise<unknown>
  setThinkingLevel: (payload: ClientMessageMap['session.setThinkingLevel']) => Promise<unknown>
}

export const sessionApi = (command: Command): SessionDomain => ({
  create: (payload) => command({ type: 'session.create', payload }),
  list: () => command({ type: 'session.list', payload: {} }),
  switch: (payload) => command({ type: 'session.switch', payload }),
  history: (payload) => command({ type: 'session.history', payload }),
  compact: (payload) => command({ type: 'session.compact', payload }),
  rename: (payload) => command({ type: 'session.rename', payload }),
  delete: (payload) => command({ type: 'session.delete', payload }),
  setThinkingLevel: (payload) => command({ type: 'session.setThinkingLevel', payload }),
})
