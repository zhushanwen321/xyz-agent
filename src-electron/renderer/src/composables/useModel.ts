import { send } from '../lib/ws-client'

export function useModel() {
  function listModels() {
    send({ type: 'model.list', payload: {} })
  }
  function switchModel(sessionId: string, provider: string, modelId: string) {
    send({ type: 'model.switch', payload: { sessionId, provider, modelId } })
  }
  function switchThinkingLevel(sessionId: string, level: string) {
    send({ type: 'session.setThinkingLevel', payload: { sessionId, level } })
  }
  return { listModels, switchModel, switchThinkingLevel }
}
