import { send } from '../lib/ws-client'

export function useToolApproval() {
  function approve(sessionId: string, toolCallId: string) {
    send({ type: 'tool.approve', payload: { sessionId, toolCallId } })
  }
  function deny(sessionId: string, payload: { toolCallId?: string; reason?: string }) {
    send({ type: 'tool.deny', payload: { sessionId, ...payload } })
  }
  function alwaysAllow(sessionId: string, toolName: string) {
    send({ type: 'tool.always_allow', payload: { sessionId, toolName } })
  }
  return { approve, deny, alwaysAllow }
}
