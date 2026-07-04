// ── Hook 类型（插件拦截/观察机制）────────────────────────────────────
//
// 本文件包含插件 hook 系统的全部类型：可拦截/可观察的 hook 类型、
// 拦截器/观察者处理函数、执行上下文与返回结果。无跨域依赖。

/** 可拦截的 hook 类型，插件可阻止或修改数据 */
export type InterceptorHookType =
  | 'onToolCall'
  | 'onSlashCommand'
  | 'onMessageSend'
  | 'onBeforeSendMessage'
  | 'onBeforeToolCall'
  | 'onBeforeAgentStart'
  | 'onAfterToolResult'

/** 只观察的 hook 类型，插件只能读取数据不能阻止 */
export type ObserverHookType = 'onMessage' | 'onSessionCreate' | 'onSessionDestroy'

/** 所有 hook 类型 */
export type HookType = InterceptorHookType | ObserverHookType

/** 拦截器返回结果：允许/阻止/修改数据 */
export interface InterceptorResult {
  proceed: boolean
  reason?: string
  modifiedData?: unknown
}

/** Hook 执行上下文 */
export interface HookContext {
  pluginId: string
  hookType: HookType
  data: unknown
  timestamp: number
  /** Phase 3: 从 event-adapter/index.ts 透传的额外上下文 */
  sessionId?: string
  content?: string
}

/** Hook 拦截器处理函数 — 可阻止或修改数据 */
export type HookInterceptor = (context: HookContext) => Promise<InterceptorResult>

/** Hook 观察者处理函数 — 只能读取数据 */
export type HookObserver = (context: HookContext) => Promise<void>

/** PiEvent 处理函数 */
export type PiEventCallback = (eventName: string, data: unknown) => Promise<void>

/** Hook 通用返回结果 */
export interface HookResult {
  blocked: boolean
  blockedBy?: string
  reason?: string
  transformedData?: unknown
}

/** Hook 被阻止时的详细结果 */
export interface HookBlockedResult extends HookResult {
  blocked: true
  reason: string
}
