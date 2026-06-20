/**
 * Mock 门面 —— 与 @/api 同接口签名，VITE_MOCK=true 时注入。
 *
 * 骨架阶段：各方法 throw（实现阶段填 mock fixture，见 plan-frontend 步骤 B）。
 */
import type { ServerMessage, SessionSummary } from '@xyz-agent/shared'

export const session = {
  list: (): Promise<SessionSummary[]> => {
    throw new Error('not implemented')
  },
  create: (title?: string): Promise<SessionSummary> => {
    throw new Error(`not implemented: create(${title ?? ''})`)
  },
  switchSession: (id: string): Promise<void> => {
    throw new Error(`not implemented: switchSession(${id})`)
  },
}

export const chat = {
  send: (sessionId: string, text: string): Promise<void> => {
    throw new Error(`not implemented: send(${sessionId}, ${text})`)
  },
  abort: (sessionId: string): Promise<void> => {
    throw new Error(`not implemented: abort(${sessionId})`)
  },
  streamSubscribe: (
    sessionId: string,
    handler: (msg: ServerMessage) => void,
  ): (() => void) => {
    throw new Error(`not implemented: streamSubscribe(${sessionId}, ${typeof handler})`)
  },
}
