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
 * onPiEvent 是泛型 observe 通道（D2-4）：事件名经 context 传给 handler，
 * 插件在 handler 内自行按事件名过滤。
 *
 * [HISTORICAL] Fix-6：曾含 'onMessage' | 'onSessionCreate' | 'onSessionDestroy' 三个
 * 字面量——无注册面（createHookApi 不暴露对应方法）、无调用面（event-interpreter /
 * bridge-interop 不以此 key 调 executeHooks），属死类型，已删除（2026-08-15 W02 审查）。
 */
export type ObserverHookType = 'onPiEvent'

/** @proposed — 所有 hook 类型 */
export type HookType = InterceptorHookType | ObserverHookType

/**
 * @proposed — 拦截器返回结果：允许/阻止/修改数据/注入消息。
 *
 * 三个语义域互不混淆（plugin-intercept-injection 设计 §3.3-D1）：
 * - 阻止：proceed:false — runtime 侧终止后续插件 hook 链并留痕；当前 pi 集成不阻止
 *   agent turn（pi before_agent_start 无 block 槽位，turn 照常进行）
 * - 改写：modifiedData — 改写当前 hook 事件的 data（如 onAfterToolResult 改写工具输出），
 *   管线按「链上最后一个」覆盖语义透传（HookResult.transformedData）
 * - 注入：injectedMessages — 新增 LLM 上下文消息，跨插件累积拼接（非改写、非阻止）
 */
export interface InterceptorResult {
  /**
   * false = 终止后续插件 hook 链 + 留痕。诚实边界：pi 链路无 block 槽位，
   * blocked 回包不阻止 agent turn（turn 照常进行）。
   */
  proceed: boolean
  /** proceed:false 时的原因描述（留痕 / blocked 回包用） */
  reason?: string
  /** 改写语义：改写当前 hook 事件的 data（链上最后一个生效，非累积）。勿用于注入 */
  modifiedData?: unknown
  /**
   * 注入语义：向 LLM 上下文新增的消息文本。契约边界（D1）：仅 onBeforeAgentStart
   * （bridge intercept 链路）被消费；其他 intercept hookType 返回非空值类型合法但
   * 无运行时效果（管线 warn 留痕，作者应移除误用）。observe hook（onPiEvent）的
   * 响应在 Worker 侧丢弃，此处误用注入无任何运行时信号，仅靠本注释约束。
   */
  injectedMessages?: string[]
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
 * @proposed — Hook 观察者处理函数（只能读取数据，不能阻止）。
 * 可选返回 InterceptorResult（proceed 恒为 true 语义，modifiedData 改写 output）——
 * onAfterToolResult 的 transform 语义经此回传（D2-3：Worker 响应携带 modifiedData，
 * 主线程 HookPipeline 映射为 HookResult.transformedData，消费侧 event-interpreter 读取）。
 */
export type HookObserver = (context: HookContext) => Promise<InterceptorResult | void>

/**
 * @proposed — PiEvent 处理函数。
 */
export type PiEventCallback = (eventName: string, data: unknown) => Promise<void>

/**
 * @internal — runtime 内部：Hook 通用返回结果（主线程塑形）。
 * injectedMessages 与 transformedData 语义分叉（plugin-intercept-injection 设计 §3.3-D2/D3）：
 * 前者为管线层逐插件形状校验后的合法条目跨插件累积拼接（priority 执行序），后者保持
 * 「链上最后一个」覆盖语义；消费方为 handleBridgeIntercept 的注入映射。
 */
export interface HookResult {
  blocked: boolean
  blockedBy?: string
  reason?: string
  transformedData?: unknown
  /** 注入语义（仅 onBeforeAgentStart 链路消费）：管线已校验的合法条目，跨插件累积 */
  injectedMessages?: string[]
}

/** @internal — runtime 内部：Hook 被阻止时的详细结果 */
export interface HookBlockedResult extends HookResult {
  blocked: true
  reason: string
}
