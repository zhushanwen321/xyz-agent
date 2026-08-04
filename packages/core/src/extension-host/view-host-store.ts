/**
 * view-host-store.ts —— ViewHostStore（IF10 + clarify Q1）。
 *
 * plugin view 的 GuiComponent 树缓存：per viewId + per-session 双键分区（createSessionScopedMap）。
 * s2 阶段数据源为 extension-widget 事件（widget:lines 纯文本 / widgetGui:gui 结构化 GuiComponent），
 * s3 的 plugin:viewUpdate 广播到达后同走此事件（经 MessageBusBridge → extension-widget）。
 *
 * 窄化规则（clarify Q1 裁决——types.ts WidgetPayload.guiTree 保持 unknown[]，bridge 生产形状
 * 是 wire 真值不改动）：
 * - isGuiComponent 校验通过 → 直存 GuiComponent[]
 * - string 行（widget:lines 纯文本）→ 包装为 { type: 'ansi-text', props: { lines: [行] } }
 *   （与 P2 GuiComponentRenderer 的 AnsiText 降级语义一致）
 * - null（widgetGui gui:null 清除语义）→ invalidate 该 viewId（清缓存条目）
 *
 * 契约（IF10）：getView / setView / invalidate(sessionId, viewId?)，invalidate 无 viewId
 * 清空该 session 全部 view（plugin 重载/崩溃时）；session-destroyed → cleanup（ERR4）。
 * GuiComponent 类型从 @xyz-agent/extension-protocol import（P2 同源）。
 */
import { isGuiComponent } from '@xyz-agent/extension-protocol'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { InternalEventBus } from './internal-event-bus'
import type { SessionScopedMap } from './utils/session-scoped-map'
import type { WidgetPayload } from './types'

/** view 缓存条目（IF10 契约）。 */
export interface ViewCacheEntry {
  viewId: string
  pluginId: string
  guiTree: GuiComponent[]
  updatedAt: number
}

export interface ViewHostStoreDeps {
  bus: InternalEventBus
  /** 分区值类型：viewId → ViewCacheEntry（per-session 分区） */
  sessionScoped: SessionScopedMap<Map<string, ViewCacheEntry>>
}

export class ViewHostStore {
  private unsubscribe: (() => void)[] = []

  constructor(private deps: ViewHostStoreDeps) {}

  /** 订阅 extension-widget（更新 view 树）+ session-destroyed（cleanup）。返回取消订阅函数。 */
  subscribe(): () => void {
    if (this.unsubscribe.length > 0) return this.dispose.bind(this)
    this.unsubscribe.push(this.deps.bus.on('extension-widget', (e) => {
      this.consumeWidget(e.sessionId, e.widget)
    }))
    this.unsubscribe.push(this.deps.bus.on('session-destroyed', (e) => {
      this.deps.sessionScoped.cleanup(e.sessionId)
    }))
    return this.dispose.bind(this)
  }

  getView(sessionId: string, viewId: string): ViewCacheEntry | undefined {
    return this.deps.sessionScoped.get(sessionId)?.get(viewId)
  }

  setView(sessionId: string, viewId: string, entry: ViewCacheEntry): void {
    this.deps.sessionScoped.update(sessionId, (partition) => {
      partition.set(viewId, entry)
    })
  }

  /** 清缓存：无 viewId 清空该 session 全部 view（plugin 重载/崩溃时，IF10 契约）。 */
  invalidate(sessionId: string, viewId?: string): void {
    if (viewId === undefined) {
      this.deps.sessionScoped.cleanup(sessionId)
      return
    }
    this.deps.sessionScoped.update(sessionId, (partition) => {
      partition.delete(viewId)
    })
  }

  /** extension-widget 事件消费：窄化 widget.guiTree 后更新缓存（gui:null 清除语义）。 */
  private consumeWidget(sessionId: string | undefined, widget: WidgetPayload): void {
    if (sessionId === undefined) return
    // gui:null 清除语义：guiTree=[null] → invalidate 该 viewId（clarify Q1）
    if (widget.guiTree.length === 1 && widget.guiTree[0] === null) {
      this.invalidate(sessionId, widget.viewId)
      return
    }
    const guiTree = this.narrowGuiTree(widget.guiTree)
    this.setView(sessionId, widget.viewId, {
      viewId: widget.viewId,
      pluginId: widget.pluginId,
      guiTree,
      updatedAt: Date.now(),
    })
  }

  /** 窄化 unknown[] → GuiComponent[]：isGuiComponent 直存；string 行包装 ansi-text（clarify Q1）。 */
  private narrowGuiTree(raw: unknown[]): GuiComponent[] {
    const result: GuiComponent[] = []
    for (const item of raw) {
      if (isGuiComponent(item)) {
        result.push(item)
      } else if (typeof item === 'string') {
        result.push({ type: 'ansi-text', props: { lines: [item] } })
      }
      // 其他形状（非法对象等）丢弃——不静默吞，调用方 setView 仍会更新（保留合法项）
    }
    return result
  }

  /** 取消全部订阅（幂等）。 */
  dispose(): void {
    for (const unsub of this.unsubscribe) unsub()
    this.unsubscribe = []
  }
}
