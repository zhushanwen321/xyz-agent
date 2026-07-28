/**
 * Plugin 域 —— 本计划只建 onPlugins 订阅骨架（解锁全局链路）。
 *
 * toggle/install/permissions 等属后续真实集成。
 * 契约见 contract.md §2.6。
 *
 * 依赖方向：events（订阅）。
 */
import type { PluginInfo } from '@xyz-agent/shared'
import * as events from '../events'

export function onPlugins(handler: (plugins: PluginInfo[]) => void): () => void {
  return events.onGlobalType('config.plugins', (msg) => {
    handler(msg.payload.plugins)
  })
}
