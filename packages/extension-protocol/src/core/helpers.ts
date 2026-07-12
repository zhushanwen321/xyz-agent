/**
 * Extension GUI 渲染协议 helper 函数（通用层）。
 *
 * 设计原则：
 * - 零运行时依赖（不依赖 pi SDK）
 * - helpers 接受最小化的 ctx 结构（结构化类型），pi 的 ExtensionContext 天然满足
 * - extension 开发者只需调这些 helper，不需要了解底层编码细节
 */

import {
  type GuiComponent,
  type GuiComponentType,
  type GuiComponentProps,
  type GuiRenderResult,
  PROTOCOL_VERSION,
} from './types'
import { GUI_WIDGET_MARKER } from './markers'
import type { GuiContext } from './gui-context'

// ── helper 函数 ──

/**
 * 检测当前环境是否支持 GUI 渲染（RPC 模式 = GUI 渲染通道有效）。
 * TUI/json/print 模式走 pi 原生渲染，不需要 GuiComponent。
 */
export function isGuiCapable(ctx: GuiContext): boolean {
  return ctx.mode === 'rpc'
}

/**
 * 构造 GuiRenderResult，放进 details.__gui__。
 * stripUndefined 确保序列化不含 undefined（JSON.stringify 会丢弃 undefined 字段）。
 */
export function guiResult(component: GuiComponent): GuiRenderResult {
  return {
    v: PROTOCOL_VERSION,
    component: stripUndefined(component) as GuiComponent,
  }
}

/**
 * 构造 GuiComponent，带类型推断。
 * 类型参数 T 约束 props 到对应类型的 props 形状。
 */
export function guiComponent<T extends GuiComponentType>(
  type: T,
  props: GuiComponentProps[T]
): GuiComponent<T> {
  return { type, props }
}

/**
 * 设置 GUI widget。RPC 模式下用 marker 编码 GuiComponent JSON 进 string[]，
 * runtime event-adapter 检测 marker 解码为结构化 WS 帧。
 * TUI 模式下此函数无操作（extension 应在 TUI 分支调原生 ctx.ui.setWidget 传 Component factory）。
 *
 * 传 undefined 清除 widget。
 */
export function guiSetWidget(
  ctx: GuiContext,
  key: string,
  component: GuiComponent | undefined
): void {
  if (!ctx.ui?.setWidget) return

  if (component) {
    const encoded = [GUI_WIDGET_MARKER + JSON.stringify(stripUndefined(component))]
    ctx.ui.setWidget(key, encoded)
  } else {
    ctx.ui.setWidget(key, undefined)
  }
}

/**
 * 从 details 中提取 GuiRenderResult。前端统一用此函数读取 __gui__，
 * 集中校验版本号，避免散落的 as 断言。
 */
export function extractGui(details: Record<string, unknown> | undefined): GuiRenderResult | undefined {
  const g = details?.__gui__
  if (
    g &&
    typeof g === 'object' &&
    'v' in g &&
    'component' in g &&
    (g as { v: unknown }).v === PROTOCOL_VERSION
  ) {
    return g as GuiRenderResult
  }
  return undefined
}

/**
 * 最小形状校验：判断 unknown 值是否为合法 GuiComponent（有 type 字符串 + props 对象）。
 * 用于 widgetGui marker 解码后防止异常结构进入渲染层。
 * 不校验 type 是否为已知值（GuiComponentRenderer 对未知 type 有 AnsiText 降级）。
 */
export function isGuiComponent(value: unknown): value is GuiComponent {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  // typeof null === 'object' 是 JS 陷阱，必须显式排除 props: null（否则下游渲染层访问 props 字段崩溃）
  return typeof obj.type === 'string'
    && obj.props !== null
    && obj.props !== undefined
    && typeof obj.props === 'object'
}

// ── 内部工具 ──

/** 递归 strip undefined 字段，确保 JSON.stringify 产出干净的对象 */
export function stripUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(stripUndefined) as T

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = typeof value === 'object' ? stripUndefined(value) : value
    }
  }
  return result as T
}
