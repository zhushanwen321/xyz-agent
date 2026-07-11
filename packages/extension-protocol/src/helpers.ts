/**
 * Extension GUI 渲染协议 helper 函数。
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
  type InteractionQuestion,
  PROTOCOL_VERSION,
} from './types'

// ── 最小化 ctx 接口（pi ExtensionContext 的结构化子集）──

/**
 * helpers 需要的 ctx 最小接口。
 * pi 的 ExtensionContext 天然满足此结构（有 mode/hasUI/ui 字段）。
 * 用结构化类型而非 import pi SDK，保持协议包零依赖。
 */
export interface GuiContext {
  mode: 'tui' | 'rpc' | 'json' | 'print'
  hasUI: boolean
  ui?: {
    setWidget?: (key: string, lines: string[] | undefined) => void
    select?: (header: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>
    input?: (header: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>
    confirm?: (header: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<boolean | undefined>
    custom?: (factory: unknown, opts?: unknown) => Promise<Record<string, string | string[]> | undefined>
  }
}

// ── 常量 ──

/** NUL 字符开头的 marker，不会出现在正常文本中。extension 用 guiSetWidget 编码进 string[]。 */
export const GUI_WIDGET_MARKER = '\x00XYZ_GUI_WIDGET:'

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
 * 交互式组件——TUI/GUI 双模路由。
 *
 * TUI 模式：调 ctx.ui.custom()（富交互：tab/分屏/freeform）。
 *           传入的 factory 应返回 extension 自定义的 TUI Component。
 * RPC 模式：降级为 ctx.ui.select()/input()/confirm() 序列。
 *           功能完整但无 tab/分屏（前端 ExtensionUIDialog 渲染标准对话框）。
 *
 * json/print 模式或无 UI 能力：返回 null。
 *
 * @returns answers 映射（header → value），用户取消返回 null
 */
export async function guiInteract(
  ctx: GuiContext,
  questions: InteractionQuestion[],
  options?: { signal?: AbortSignal }
): Promise<Record<string, string | string[]> | null> {
  if (!ctx.hasUI) return null

  if (ctx.mode === 'tui') {
    // TUI 模式：调 ctx.ui.custom()，由 extension 提供自己的 TUI Component
    if (!ctx.ui?.custom) return null
    const result = await ctx.ui.custom(undefined, { signal: options?.signal })
    return result ?? null
  }

  // RPC 模式：降级为 dialog 序列
  const answers: Record<string, string | string[]> = {}

  for (const q of questions) {
    if (q.options && q.options.length > 0) {
      if (q.multiSelect) {
        // 多选降级：逐选项 confirm（体验有限，P3 会扩展为结构化 response）
        const selected: string[] = []
        for (const opt of q.options) {
          const yes = await ctx.ui?.confirm?.(q.header, `选择 ${opt.label}?`, { signal: options?.signal })
          if (yes) selected.push(opt.value)
        }
        answers[q.header] = selected
      } else {
        // 单选：ctx.ui.select（RPC 原生支持）
        const choice = await ctx.ui?.select?.(
          q.header,
          q.options.map(o => o.label),
          { signal: options?.signal }
        )
        if (choice === undefined) return null
        answers[q.header] = q.options.find(o => o.label === choice)?.value ?? choice
      }
    } else {
      // 自由输入
      const text = await ctx.ui?.input?.(q.header, q.question, { signal: options?.signal })
      if (text === undefined) return null
      answers[q.header] = text
    }
  }

  return answers
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

// ── 内部工具 ──

/** 递归 strip undefined 字段，确保 JSON.stringify 产出干净的对象 */
function stripUndefined<T>(obj: T): T {
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
