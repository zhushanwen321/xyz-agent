/**
 * Status Bar 注册表（StatusBarRegistry）
 *
 * 从 PluginService 抽出的正交职责：维护插件注册的 status bar item，
 * 并在变更时广播 `plugin:statusBarUpdate`（ADR-0023 契约不变）。
 *
 * 行为契约（与原 PluginService 完全一致）：
 * - itemKey = `${pluginId}:${id}`，空 text 表示移除该 item。
 * - 新增/更新/删除后立即广播当前全量 items。
 * - clearForPlugin(pluginId) 清理某插件全部 item（停用/卸载时调用），有变更才广播。
 * - getItems() 返回当前全量 item（供 renderer 主动拉取）。
 *
 * 依赖：仅依赖一个 broadcast 回调（payload 为 { items }），不耦合 broker 细节。
 */

import type { StatusBarItem } from '@xyz-agent/shared'

/** 广播回调：把 status bar 更新推给前端（type 固定为 'plugin:statusBarUpdate'） */
export type StatusBarBroadcastFn = (payload: { items: StatusBarItem[] }) => void

export class StatusBarRegistry {
  /** Status bar items registry，key 为 `${pluginId}:${id}` */
  readonly items = new Map<string, StatusBarItem>()

  private readonly broadcast: StatusBarBroadcastFn

  constructor(broadcast: StatusBarBroadcastFn) {
    this.broadcast = broadcast
  }

  /** Get all current status bar items */
  getItems(): StatusBarItem[] {
    return Array.from(this.items.values())
  }

  /** Broadcast current status bar items to all clients */
  broadcastAll(): void {
    const items = this.getItems()
    this.broadcast({ items })
  }

  /** Clear all status bar items for a given plugin (used during deactivation) */
  clearForPlugin(pluginId: string): void {
    let changed = false
    for (const [key, item] of this.items) {
      if (item.pluginId === pluginId) {
        this.items.delete(key)
        changed = true
      }
    }
    if (changed) this.broadcastAll()
  }
}
