/**
 * Model 域 —— 模型列表订阅 + 切换动作。
 *
 * 契约见 contract.md §2.4。
 * - onModels 走订阅（sendInitialState 推 model.list）。
 * - switchModel 是动作（确认由 model.switched 推回，本计划暂不订阅 switched，后续真实集成接）。
 *
 * 依赖方向：events（订阅）+ transport + pending（动作）。
 */
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

/**
 * 模型信息（mock 阶段过渡类型：从 model.list payload 推断的扁平结构）。
 * 字段对照 runtime 确认；真实集成时若需对齐 shared/provider.ts 的 ModelInfo 再迁移。
 */
export interface ModelInfo {
  id: string
  name: string
  provider: string
  providerColor?: string
  tag?: string
}

/** 订阅模型列表（config.providers 解析后的聚合模型，sendInitialState 推） */
export function onModels(handler: (models: ModelInfo[]) => void): () => void {
  return events.onGlobalType('model.list', (msg) => {
    handler(msg.payload.models as ModelInfo[])
  })
}

/** 切换当前 session 的模型（动作；确认由 model.switched push，后续消费） */
export function switchModel(
  sessionId: string,
  provider: string,
  modelId: string,
): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'model.switch', id, payload: { sessionId, provider, modelId } })
  return result
}
