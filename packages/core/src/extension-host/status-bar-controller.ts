/**
 * status-bar-controller.ts —— StatusBarController（IF8 + AC7）。
 *
 * 两 scope 状态栏聚合器：订阅 InternalEventBus 的 plugin-status-bar-update /
 * plugin-status-set-update / extension-status / session-destroyed，按 scope 分流聚合。
 * per-session 分区用 createSessionScopedMap（ADR-0049 范式，DM2），global 聚合在模块私有
 * globalState。信息流向单向：runtime 广播 → bridge → bus → controller（feature D5，
 * 不反向读 domain）。
 *
 * AC7：绝不 import domain store（静态 import 检查由 scripts/verify-extension-host-boundaries.mjs
 * 强制——本文件只依赖 types + internal-event-bus + utils/session-scoped-map）。
 *
 * 聚合规则（clarify Q3 裁决）：
 * - plugin-status-bar-update items 逐项按 scope 分流：scope==='global'（或缺失）→ globalState.items；
 *   scope==='per-session' → sessionScoped 分区（分区键优先级 item.sessionId > event.sessionId
 *   > '__global__' 兜底）
 * - plugin-status-set-update → 分区 setEntries（sessionId 缺失 → '__global__'）
 * - extension-status → 分区 extensionStatus（sessionId 缺失 → '__global__'）
 * - session-destroyed → sessionScoped.cleanup(sid)（ERR4 防内存泄漏）
 */
import type { InternalEventBus } from './internal-event-bus'
import type { SessionScopedMap } from './utils/session-scoped-map'
import type { StatusBarEntry, StatusSetEntry, ExtensionStatusEntry } from './types'

/** 无 sessionId 时的分区兜底键（与 overlay-lifecycle 的 GLOBAL_OVERLAY_KEY 语义一致）。 */
export const GLOBAL_STATUS_KEY = '__global__'

/** per-session 分区状态容器（IF8 契约）。 */
export interface StatusBarSessionState {
  items: StatusBarEntry[]
  setEntries: StatusSetEntry[]
  extensionStatus?: ExtensionStatusEntry
}

export interface StatusBarControllerDeps {
  bus: InternalEventBus
  sessionScoped: SessionScopedMap<StatusBarSessionState>
}

export class StatusBarController {
  /** global scope 聚合（模块私有字段，IF8 契约）。 */
  private globalState: { items: StatusBarEntry[] } = { items: [] }
  private unsubscribe: (() => void)[] = []

  constructor(private deps: StatusBarControllerDeps) {}

  /** 订阅四类事件，返回取消订阅函数（listener 防翻倍，项目规则#2）。 */
  subscribe(): () => void {
    if (this.unsubscribe.length > 0) return this.dispose.bind(this)
    this.unsubscribe.push(this.deps.bus.on('plugin-status-bar-update', (e) => this.handleStatusBarUpdate(e)))
    this.unsubscribe.push(this.deps.bus.on('plugin-status-set-update', (e) => this.handleStatusSetUpdate(e)))
    this.unsubscribe.push(this.deps.bus.on('extension-status', (e) => this.handleExtensionStatus(e)))
    this.unsubscribe.push(this.deps.bus.on('session-destroyed', (e) => this.deps.sessionScoped.cleanup(e.sessionId)))
    return this.dispose.bind(this)
  }

  /** 取状态栏条目：global scope 或 per-session 分区（分区不存在返回空数组）。 */
  getItems(scope: 'global'): StatusBarEntry[]
  getItems(scope: 'per-session', sessionId: string): StatusBarEntry[]
  getItems(scope: 'per-session' | 'global', sessionId?: string): StatusBarEntry[] {
    if (scope === 'global') return this.globalState.items
    const sid = sessionId ?? GLOBAL_STATUS_KEY
    return this.deps.sessionScoped.get(sid)?.items ?? []
  }

  /** 取 per-session 分区全部状态（items + setEntries + extensionStatus），供 s4 渲染。 */
  getSessionState(sessionId: string): StatusBarSessionState | undefined {
    return this.deps.sessionScoped.get(sessionId)
  }

  /** 分区键优先级：item.sessionId > event.sessionId > '__global__'（clarify Q3）。 */
  private resolvePartitionKey(itemSessionId: string | undefined, eventSessionId: string | undefined): string {
    return itemSessionId ?? eventSessionId ?? GLOBAL_STATUS_KEY
  }

  private handleStatusBarUpdate(e: { sessionId?: string; items: StatusBarEntry[] }): void {
    for (const item of e.items) {
      if (item.scope === 'per-session') {
        const key = this.resolvePartitionKey(item.sessionId, e.sessionId)
        this.deps.sessionScoped.update(key, (s) => {
          s.items.push(item)
        })
      } else {
        // scope==='global'（或缺失）→ globalState（IF8 契约）
        this.globalState.items.push(item)
      }
    }
  }

  private handleStatusSetUpdate(e: { sessionId?: string; status: StatusSetEntry[] }): void {
    const key = e.sessionId ?? GLOBAL_STATUS_KEY
    this.deps.sessionScoped.update(key, (s) => {
      s.setEntries.push(...e.status)
    })
  }

  private handleExtensionStatus(e: { sessionId?: string; status: ExtensionStatusEntry }): void {
    const key = e.sessionId ?? GLOBAL_STATUS_KEY
    this.deps.sessionScoped.update(key, (s) => {
      s.extensionStatus = e.status
    })
  }

  /** 取消全部订阅（幂等）。 */
  dispose(): void {
    for (const unsub of this.unsubscribe) unsub()
    this.unsubscribe = []
  }
}
