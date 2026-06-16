import { api } from '../api'

export function useToolApproval() {
  function approve(sessionId: string, toolCallId: string) {
    api.command({ type: 'tool.approve', payload: { sessionId, toolCallId } })
  }
  function deny(sessionId: string, payload: { toolCallId?: string; reason?: string }) {
    api.command({ type: 'tool.deny', payload: { sessionId, ...payload } })
  }
  function alwaysAllow(sessionId: string, toolName: string) {
    api.command({ type: 'tool.always_allow', payload: { sessionId, toolName } })
  }
  return { approve, deny, alwaysAllow }
}
