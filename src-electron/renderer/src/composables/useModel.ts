import { ref } from 'vue'
import { send } from '../lib/ws-client'
import type { ModelInfo } from '@xyz-agent/shared'

export function useModel() {
  const models = ref<ModelInfo[]>([])

  function loadModels() {
    send({ type: 'model.list', payload: {} })
  }

  function switchModel(sessionId: string, modelId: string) {
    send({ type: 'model.switch', payload: { sessionId, modelId } })
  }

  return { models, loadModels, switchModel }
}
