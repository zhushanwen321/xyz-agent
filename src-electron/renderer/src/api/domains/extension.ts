/**
 * Extension 域 —— 本计划只建 onExtensions 订阅 + toggle 动作骨架。
 *
 * install/uninstall 完整流程属后续真实集成，本计划不展开。
 * 契约见 contract.md §2.5。
 *
 * 依赖方向：events（订阅）+ transport + pending（动作）。
 */
import type { ExtensionInfo } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

export function onExtensions(handler: (extensions: ExtensionInfo[]) => void): () => void {
  return events.onGlobalType('config.extensions', (msg) => {
    handler(msg.payload.extensions as ExtensionInfo[])
  })
}

export function toggle(name: string, enabled: boolean): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.toggle', id, payload: { name, enabled } })
  return result
}
