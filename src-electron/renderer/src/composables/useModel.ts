import { api } from '../api'

export function useModel() {
  function listModels() {
    api.model.list()
  }
  function switchModel(sessionId: string, provider: string, modelId: string) {
    api.model.switch({ sessionId, provider, modelId })
  }
  function switchThinkingLevel(sessionId: string, level: string) {
    api.session.setThinkingLevel({ sessionId, level })
  }
  return { listModels, switchModel, switchThinkingLevel }
}
