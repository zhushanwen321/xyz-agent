/**
 * Hook 类型（插件拦截/观察机制）
 *
 * 分层标注（IF2）：
 * - @proposed — Hook 机制整体为 Phase 2 扩展面（API 表面仍在演进）
 * - @internal — runtime 内部执行细节（HookResult/HookBlockedResult 等主线程塑形）
 */

/**
 * @proposed — 可拦截的 hook 类型，插件可阻止或修改数据。
 */
export type InterceptorHookType =
  | 'onToolCall'
  | 'onSlashCommand'
  | 'onMessageSend'
  | 'onBeforeSendMessage'
  | 'onBeforeToolCall'
  | 'onBeforeAgentStart'
  | 'onAfterToolResult'

/**
 * @proposed — 只观察的 hook 类型，插件只能读取数据不能阻止。
 */
export type ObserverHookType = 'onMessage' | 'onSessionCreate' | 'onSessionDestroy'

/** @proposed — 所有 hook 类型 */
export type HookType = InterceptorHookType | ObserverHookType

/**
 * @proposed — 拦截器返回结果：允许/阻止/修改数据。
 */
export interface InterceptorResult {
  proceed: boolean
  reason?: string
  modifiedData?: unknown
}

/**
 * @proposed — Hook 执行上下文。
 */
export interface HookContext {
  pluginId: string
  hookType: HookType
  data: unknown
  timestamp: number
  /** Phase 3: 从 event-adapter/index.ts 透传的额外上下文 */
  sessionId?: string
  content?: string
}

/**
 * @proposed — Hook 拦截器处理函数（可阻止或修改数据）。
 */
export type HookInterceptor = (context: HookContext) => Promise<InterceptorResult>

/**
 * @proposed — Hook 观察者处理函数（只能读取数据）。
 */
export type HookObserver = (context: HookContext) => Promise<void>

/**
 * @proposed — PiEvent 处理函数。
 */
export type PiEventCallback = (eventName: string, data: unknown) => Promise<void>

/** @internal — runtime 内部：Hook 通用返回结果（主线程塑形） */
export interface HookResult {
  blocked: boolean
  blockedBy?: string
  reason?: string
  transformedData?: unknown
}

/** @internal — runtime 内部：Hook 被阻止时的详细结果 */
export interface HookBlockedResult extends HookResult {
  blocked: true
  reason: string
}
