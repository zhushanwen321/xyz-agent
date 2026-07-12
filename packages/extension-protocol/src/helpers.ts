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
  type InteractionAnswers,
  GUI_INTERACT_MARKER,
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

// ── 富交互（guiInteract）──
//
// custom() 在 RPC 模式不可用（Component 是代码），「表单类」交互改走 select 通道：
// helper 把 InteractionQuestion[] 序列化进 select 的 options[0]，runtime event-adapter
// 检测 title marker 透传 questions，前端 InteractionOverlay 渲染富交互 UI。
// 回传仍走 select 的 value 字段（JSON.stringify(answers)），复用 select 全部管道逻辑。
//
// @see spec.md §4 协议包 API + §5 时序分析（为什么走 options[0]）

/**
 * 富交互入口（RPC 模式专用）。
 *
 * RPC 模式：用 select 通道携带 questions 数据，前端渲染富交互 UI。
 * TUI 模式：抛错。extension 必须自行调 ctx.ui.custom()。
 *
 * @param ctx        ExtensionContext（pi 提供）
 * @param questions  交互问题声明
 * @param options    可选：signal（abort）、allowCancel（前端是否显示取消按钮）
 * @returns          answers（key=header/question, value=JSON编码的答案），用户取消返回 null
 */
export async function guiInteract(
  ctx: GuiContext,
  questions: InteractionQuestion[],
  options?: { signal?: AbortSignal; allowCancel?: boolean },
): Promise<InteractionAnswers | null> {
  // 空 questions 防御（与「用户 Submit 空表单」语义一致，返回 {}）
  if (questions.length === 0) return {}

  // RPC 模式：select 通道携带 questions 数据
  if (isGuiCapable(ctx) && ctx.ui?.select) {
    // questions 数据序列化进 options[0]。
    // pi select 的 request 硬编码 {method, title, options, timeout}（rpc-mode.ts:136-137），
    // helper 无法通过 ctx.ui.select 的标准参数注入自定义字段，只能借用 options 数组。
    // options 是 string[]，JSON.stringify 产出合法 string 元素，pi 原样透传。
    const payload = JSON.stringify(stripUndefined({
      questions,
      allowCancel: options?.allowCancel ?? true,
    }))
    const value = await ctx.ui.select(
      GUI_INTERACT_MARKER,           // title = marker，runtime/前端据此识别
      [payload],                      // options[0] = JSON payload（runtime 解析）
      { signal: options?.signal },
    )
    // select 返回 undefined = 用户取消 / 超时 / abort
    if (value === undefined) return null
    // value 是前端 JSON.stringify 的 answers
    try {
      return JSON.parse(value) as InteractionAnswers
    } catch {
      // parse 失败（中间环节篡改）视为取消
      return null
    }
  }

  // 非 RPC 模式：guiInteract 不支持 TUI 渲染。
  // TUI Component 是 extension 特定的（AskUserComponent 不能通用），helper 不代劳。
  // 抛错而非返回 null——返回 null 会与「用户取消」混淆，让 extension 误以为用户取消了。
  throw new Error(
    'guiInteract() is only available in RPC mode. ' +
    'In TUI mode, use ctx.ui.custom() with your own Component directly.',
  )
}

/** answers 的 key：header 缺失时用 question 文本 */
function interactionKey(question: InteractionQuestion): string {
  return question.header ?? question.question
}

/**
 * 从 answers 中提取某个问题的选中值（单选返回 string，多选返回 string[]）。
 *
 * 多选 answers 的 value 是 JSON.stringify(string[])，此 helper 自动 parse。
 * parse 失败时降级返回 [raw]（兼容非标准格式的回传）。
 */
export function getInteractionAnswer(
  answers: InteractionAnswers,
  question: InteractionQuestion,
): string | string[] | undefined {
  const key = interactionKey(question)
  const raw = answers[key]
  if (raw === undefined) return undefined
  if (question.multiSelect) {
    try { return JSON.parse(raw) as string[] } catch { return [raw] }
  }
  return raw
}

/** 从 answers 中提取 Other 自由文本 */
export function getInteractionOther(
  answers: InteractionAnswers,
  question: InteractionQuestion,
): string | undefined {
  return answers[`${interactionKey(question)}__other`]
}

/** 从 answers 中提取评论 */
export function getInteractionComment(
  answers: InteractionAnswers,
  question: InteractionQuestion,
): string | undefined {
  return answers[`${interactionKey(question)}__comment`]
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
