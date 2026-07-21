/**
 * ExtensionRegistry —— 已知 extension 的 UI 事件分流层。
 *
 * 背景：xyz-agent 对某些 extension（goal/todo/subagents 等）做特殊 UI 适配——它们的事件不走
 * SideDrawer 的通用 widget/status 渲染管线（terminal/browser tab + status footer），而是路由到
 * 专属 UI（tasks tab / subagents view 等）。此前这种「特殊处理」硬编码在 SideDrawer 的 3 个
 * onMessage handler 里（`if widgetKey === 'goal' ... return`），每加一个已知 extension 就要改 UI 容器，
 * 通用渲染层不干净。
 *
 * 本注册表把分流逻辑收敛成一层：SideDrawer 的 widget/widgetGui/status handler 开头先过
 * `ExtensionRegistry.route*`，命中已注册 adapter 就消费（不向通用管线传播），未命中走默认渲染。
 *
 * 职责边界：只管 extension UI 事件（widget/widgetGui/status）。tool result 通路（pi tool_execution_end
 * → chat-message-effects.routeToolResultToTasks → tasks store）是 message 流，不走本注册表。
 *
 * 注册时机：adapter 模块 import 时副作用注册（`registerTasksAdapter()` 在 adapter 文件顶层调用），
 * 首次 import 该 adapter 即生效。消费侧（SideDrawer）只需 import adapter 文件触发注册。
 *
 * 线程模型：单进程 renderer，模块级单例 Map，无需并发保护。
 */
import type { GuiComponent } from '@xyz-agent/extension-protocol'

/** 已知 extension 的 UI 事件 adapter。一个 adapter 可认领多个 widgetKey/statusKey */
export interface KnownExtensionAdapter {
  /** 该 adapter 认领的 widgetKey（小写匹配）。命中即调用 onWidget/onWidgetGui，不进通用管线 */
  readonly widgetKeys: readonly string[]
  /** 该 adapter 认领的 statusKey（小写匹配）。命中即调用 onStatus，不进通用 status footer */
  readonly statusKeys: readonly string[]
  /** extension:widget（ANSI 文本行）到达且 widgetKey 命中时调用 */
  onWidget?(sessionId: string, widgetKey: string, lines: string[]): void
  /** extension:widgetGui（结构化 GUI 组件，gui===null 表示清除）到达且 widgetKey 命中时调用 */
  onWidgetGui?(sessionId: string, widgetKey: string, gui: GuiComponent | null): void
  /** extension:status 到达且 statusKey 命中时调用 */
  onStatus?(sessionId: string, statusKey: string, text: string, textRaw: string | undefined): void
}

/** 注册条目：认领的 key 集合（小写）+ adapter */
interface RegistryEntry {
  widgetKeySet: Set<string>
  statusKeySet: Set<string>
  adapter: KnownExtensionAdapter
}

const entries: RegistryEntry[] = []

/** 按 widgetKey / statusKey 的反向索引（命中查询用，O(1)） */
const widgetKeyIndex = new Map<string, KnownExtensionAdapter>()
const statusKeyIndex = new Map<string, KnownExtensionAdapter>()

/**
 * 注册一个已知 extension adapter。重复注册同一组 key 会覆盖（幂等，支持 HMR）。
 * key 统一小写存储（extension 推的 widgetKey/statusKey 大小写不可控，case-insensitive 匹配）。
 */
export function registerKnownExtension(adapter: KnownExtensionAdapter): void {
  const widgetKeySet = new Set(adapter.widgetKeys.map((k) => k.toLowerCase()))
  const statusKeySet = new Set(adapter.statusKeys.map((k) => k.toLowerCase()))
  // 幂等：先移除同 adapter 的旧条目（HMR 场景 adapter 对象重建）
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].adapter === adapter) entries.splice(i, 1)
  }
  entries.push({ widgetKeySet, statusKeySet, adapter })
  // 重建反向索引（简单可靠，adapter 数量极少）
  widgetKeyIndex.clear()
  statusKeyIndex.clear()
  for (const e of entries) {
    for (const k of e.widgetKeySet) widgetKeyIndex.set(k, e.adapter)
    for (const k of e.statusKeySet) statusKeyIndex.set(k, e.adapter)
  }
}

/** extension:widget 分流。命中已注册 adapter → 调其 onWidget 并返回 true（消费）；未命中返回 false */
export function routeWidget(sessionId: string, widgetKey: string, lines: string[]): boolean {
  const adapter = widgetKeyIndex.get(widgetKey.toLowerCase())
  if (!adapter?.onWidget) return false
  adapter.onWidget(sessionId, widgetKey, lines)
  return true
}

/** extension:widgetGui 分流。命中 → 调 onWidgetGui 返回 true；未命中返回 false */
export function routeWidgetGui(
  sessionId: string,
  widgetKey: string,
  gui: GuiComponent | null,
): boolean {
  const adapter = widgetKeyIndex.get(widgetKey.toLowerCase())
  if (!adapter?.onWidgetGui) return false
  adapter.onWidgetGui(sessionId, widgetKey, gui)
  return true
}

/** extension:status 分流。命中 → 调 onStatus 返回 true；未命中返回 false */
export function routeStatus(
  sessionId: string,
  statusKey: string,
  text: string,
  textRaw: string | undefined,
): boolean {
  const adapter = statusKeyIndex.get(statusKey.toLowerCase())
  if (!adapter?.onStatus) return false
  adapter.onStatus(sessionId, statusKey, text, textRaw)
  return true
}

/** 测试用：清空注册表（仅 __tests__ 调，防跨用例污染） */
export function __resetExtensionRegistry(): void {
  entries.length = 0
  widgetKeyIndex.clear()
  statusKeyIndex.clear()
}
