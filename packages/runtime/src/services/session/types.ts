/**
 * Session 模块内部共享类型。
 *
 * 叶子模块:仅 `import type`,不引入任何项目内运行时依赖,
 * 因此 interfaces.ts 反向 import 此处的类型不会形成模块环
 * (types.ts ← interfaces.ts 单向)。
 *
 * Facade 内部用完整 ManagedSession(extends IManagedSessionView,
 * 额外持有 adapter 等运行时句柄)。
 * 子模块经 ISessionServiceInternal 只看到 IManagedSessionView,
 * 但拿到的是 ManagedSession 实例,可读写字段(lastActiveAt / isGenerating)。
 */
import type { ServerMessage } from '@xyz-agent/shared'
import type { ScannedSessionMeta } from '../ports/session.js'

/** SendMessage hook:消息发送前触发,可阻止发送。 */
export type SendMessageHook = (sessionId: string, content: string) => Promise<{ blocked: boolean; reason?: string } | null>

/** scanPiSessions 返回的元素类型（经 ISessionStore.scanSessions）。 */
export type ScannedSession = ScannedSessionMeta

/**
 * ManagedSession 的子模块可见视图(不含运行时句柄)。
 * 子模块经此引用更新 lastActiveAt / isGenerating 等可变字段。
 */
export interface IManagedSessionView {
  id: string
  cwd: string
  label: string
  modelId: string
  createdAt: number
  lastActiveAt: number
  tokenCount: number
  /** 最近一次 agent_end / context.update 的 inputTokens 缓存，供 switchModel 重算用量 */
  inputTokens: number
  isGenerating: boolean
  /**
   * compact 进行中标记（W3, U6）。
   *
   * compact 期间 pi 正在做上下文压缩（不开 isGenerating），sendPrompt 的 busy 预检
   * 只看 isGenerating 会让 compact 中途的消息进入 pi.prompt 触发竞态/卡死。
   * 故 compact 用 try/finally 置此标记，sendPrompt 预检同时拒 isGenerating/isCompacting。
   * 与 isGenerating 对称：不进 toSummary（前端状态摘要只看 isGenerating 推 active/idle）。
   */
  isCompacting: boolean
  thinkingLevel?: string
  sessionFilePath?: string
  /**
   * 隐藏 session（公共 session）：不进 sidebar 列表（scanner listAll 过滤），
   * 仅供内部使用（如 landing 态命令源）。toSummary 透传到 SessionSummary.hidden。
   */
  hidden?: boolean
  /**
   * 父 session 血缘键（FR-2 active 路径回传血缘）。fork 出的 session 在 initializeManagedSession
   * 时写入，toSummary 透传到 SessionSummary.parentSession。源 session 未落盘时用源 sessionId 作
   * fallback（FR-20）。ManagedSession 经 extends 自动继承此字段。
   */
  parentSession?: string
  /** fork 锚点 entry id（FR-2）。toSummary 透传到 SessionSummary.forkEntryId。 */
  forkEntryId?: string
  /**
   * label 是否已持久化到 session JSONL 的 session_info 行。
   *
   * pi 0.80.3 的 SessionManager._persist 首次 flush（首条 assistant 消息后）才用
   * openSync("wx") 创建文件，且 flush 时**不写 session_info**（已验证：真实 session
   * 文件 0 个 session_info 行）。若在 flush 前用 persistSessionName 创建文件会撞
   * EEXIST 导致 session 卡死（[HISTORICAL] 规则 #6）。故 label 写盘推迟到首次
   * turn_end（第一个 LLM 回合结束，pi 已完成该轮 flush，文件存在 → append 安全）。
   *
   * 纯运行时标记，不进 toSummary，不暴露给前端。
   */
  labelPersisted: boolean
}

// ── PiTranslatedEvent：infra(event-adapter) → service(interpreter) 中间事件 ──

/**
 * pi 事件经 EventAdapter「纯翻译」后产出的中间事件（R1 重构）。
 *
 * 设计目标：把 event-adapter 从「翻译 + 业务编排混合体」收敛为纯翻译器。
 * adapter 只负责把 pi 原始事件（动态 JSON）翻译为下面这些结构化中间事件，
 * 不做任何副作用（不调 hook、不 diff git、不回写状态、不持有可变态）。
 *
 * 中间事件分两类：
 * 1. `message` —— 纯 WS 帧翻译结果，interpreter 直接转发（无业务处理）。
 * 2. 其余 kind —— 携带「业务编排所需的最小上下文」，interpreter 据此执行副作用：
 *    - hook 触发 / 阻断 / 改写（tool-call-start/end 携带原始 input/output 供 hook 改写后转发）
 *    - file_changes baseline diff（tool-changed / turn-bound）
 *    - context.update / thinkingLevel 回写 session 缓存
 *    - status / bridge / extension-ui 路由到 server
 *
 * 一个 pi 事件可产生多个 translated event（数组返回）。
 * EventAdapter 不 import services 域类型 —— hook 的结构化契约（HookTransform）编码在此，
 * 彻底消除 infra→services 的反向依赖（原 `HookResult` import）。
 */
export type PiTranslatedEvent =
  /** 纯 WS 帧翻译结果，interpreter 直接转发。 */
  | { kind: 'message'; message: ServerMessage }
  /** 无输出（pi 内部记账事件，如 NULL_EVENTS / toolResult 抑制）。 */
  | { kind: 'noop' }
  /** assistant turn 开始（message_start 无 role / 兜底）。interpreter 记 messageId + 采 baseline 快照。 */
  | { kind: 'turn-start'; messageId: string }
  /** 工具调用开始 —— interpreter 跑 onBeforeToolCall hook（可阻断/改写 input）后产出 tool_call_start。 */
  | {
      kind: 'tool-call-start'
      toolCallId: string
      toolName: string
      input: unknown
    }
  /** 工具调用结束 —— interpreter 跑 onAfterToolResult hook（改写 output）+ 触发 file_changes diff。 */
  | {
      kind: 'tool-call-end'
      toolCallId: string
      output: string
      /** 原始文本（含 ANSI 转义），output 已 stripAnsi。有 ANSI 时 outputRaw !== output。 */
      outputRaw?: string
      details: Record<string, unknown> | undefined
      images: Array<{ data: string; mimeType: string }> | undefined
      toolName: string
      isError: boolean
    }
  /** turn 结束（agent_end）—— interpreter 触发 context.update 回写 + file_changes ready diff + hook + baseline 清空。 */
  | {
      kind: 'turn-end'
      message: ServerMessage
      inputTokens?: number
      totalTokens?: number
      stopReason?: string
      usage?: { input?: number; output?: number; totalTokens?: number; cacheRead?: number; cacheWrite?: number }
    }
  /**
   * 单 turn 用量更新（pi turn_end）—— 只回写 context.update，不转发 message.complete。
   * 与 turn-end（agent_end）的区别：pi 0.80.3 一个 agent 循环含 N 个 turn，每个 turn_end 带 usage；
   * 若每 turn 都走 turn-end 路径会触发 message.complete → 前端 setStreaming(false) 闪烁。
   * 故 turn_end 走本 kind，仅刷新用量数字；message.complete 仍由 agent_end（turn-end）独占。
   */
  | { kind: 'turn-usage'; sessionId: string; inputTokens: number; totalTokens: number }
  /** extension setStatus —— interpreter 路由到 server.handleStatusSetUpdate + 转发 WS。 */
  | { kind: 'status-set'; sessionId: string; key: string; text: string; textRaw?: string }
  /** extension setStatus 对应的 WS 帧（interpreter 转发）。 */
  | { kind: 'status-broadcast'; message: ServerMessage }
  /** bridge:* 前缀请求 —— interpreter 路由到 server.handleBridgeRequest。 */
  | { kind: 'bridge-ui'; requestId: string; sessionId: string; method: string; data: Record<string, unknown> }
  /** 交互式 extension_ui_request（confirm/select/input/notify/editor）—— interpreter 注册超时。 */
  | { kind: 'extension-ui'; requestId: string; sessionId: string; method: string; payload: Record<string, unknown> }
  /** thinking_level_changed —— interpreter 回写 session 缓存（与 session.thinkingLevelSet WS 帧成对）。 */
  | { kind: 'thinking-level'; level: string | undefined }
  /** 触发 plugin hook（agent_start / tool_execution_* / agent_end 等观测事件）—— interpreter 调 pluginService.executeHooks。 */
  | { kind: 'hook'; eventType: string; data: Record<string, unknown> }
  /**
   * subagent 逐字 streaming（路径 A-1）—— 扩展层合并 text_delta 后经 setWidget("subagent-stream-<id>") 转发。
   * interpreter 转成 subagent.stream_delta WS 帧 → 前端 applyStreamDelta 增量更新虚拟 session。
   * lines 是累积全文（split('\n')），undefined = subagent 终态清除（setWidget(key, undefined)）。
   */
  | { kind: 'subagent-stream'; sessionId: string; recordId: string; lines: string[] | undefined }

