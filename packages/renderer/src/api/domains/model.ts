/**
 * Model 域 —— 模型列表订阅 + 切换动作。
 *
 * 契约见 contract.md §2.4。
 * - onModels 走订阅（sendInitialState 推 model.list）。ModelInfo 统一用 shared/provider.ts
 *   的定义（runtime aggregateModels 生产的形状），不再本地臆造扁平结构。
 * - switchModel 是动作（确认由 model.switched 推回，本计划暂不订阅 switched，后续真实集成接）。
 *
 * 依赖方向：events（订阅）+ command（动作）。
 */
import type { ModelInfo } from '@xyz-agent/shared'
export type { ModelInfo }
import { command } from '../request'
import * as events from '../events'

/** 订阅模型列表（config.providers 解析后的聚合模型，sendInitialState 推） */
export function onModels(handler: (models: ModelInfo[]) => void): () => void {
  return events.onGlobalType('model.list', (msg) => {
    handler(msg.payload.models)
  })
}

/** 切换当前 session 的模型（动作；确认由 model.switched push，后续消费） */
export function switchModel(
  sessionId: string,
  provider: string,
  modelId: string,
): Promise<void> {
  return command('model.switch', { sessionId, provider, modelId })
}
