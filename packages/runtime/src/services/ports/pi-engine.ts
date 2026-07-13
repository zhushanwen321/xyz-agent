/**
 * Pi Engine 域 ports —— pi 引擎交互 + 进程池管理。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/rpc-client.ts + process-manager.ts 实现。
 * services 经此与 pi 交互，不直接持有 RpcClient/ProcessManager 具体类。
 *
 * 归属约定（D24 收口）：pi 相关的 port 定义一律在本文件，interfaces.ts 只保留
 * 跨服务 facade 契约。本文件是 pi 引擎 / 进程池接口的唯一权威定义点。
 */

/**
 * pi 任意 JSON 响应的逃生类型。
 *
 * pi 的命令响应结构是动态的（get_state/fork/getHistory 各不相同），无法用单一精确类型
 * 描述。services 用 `as PiMessage` 后再 `as` 具体结构——这是「类型系统对 pi 动态响应认输」
 * 的诚实标注，不是协议泄露。
 *
 * 注意：sendCommand/sendRaw 逃生口已从 IPiEngine 删除（W2 收口）。响应归一下沉到
 * RpcClient 内部，services 只消费语义方法（switchSession/getState/sendExtensionUiResponse 等），
 * 不再有「发任意 pi 命令」的能力。
 */
export type PiMessage = unknown

/** pi 事件监听器：接收原始 pi 事件（动态 JSON），由 EventAdapter 翻译成 ServerMessage。 */
export type PiEventListener = (event: PiMessage) => void

/** pi 扩展命令描述（getCommands 返回项）。 */
export interface PiCommandInfo {
  name: string
  description?: string
  source: string
}

/**
 * pi compact RPC 返回的压缩结果（agent-session.ts CompactionResult）。
 * dispatcher 用 summary/tokensBefore 广播 message.compactionSummary，
 * 用 estimatedTokensAfter 触发 context.update 刷新用量。
 */
export interface PiCompactionResult {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  estimatedTokensAfter?: number
}

/**
 * pi 当前上下文占用估算（get_session_stats.contextUsage）。
 * pi 从 session 历史实时估算，处理了 compaction 边界。
 * tokens=null 表示 compaction 后未跑新 turn，占用未知。
 */
export interface PiContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

/** pi get_session_stats 响应。contextUsage.tokens=null（compact 后无新 turn）时，
 *  fetchContext 退化用 tokens.total（保留消息的 usage 累加）做近似占用估算。 */
export interface PiSessionStats {
  contextUsage?: PiContextUsage
  /** 所有 assistant 消息 usage 累加（input+output+cacheRead+cacheWrite）。compact 后保留消息少时近似当前占用。 */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

/** pi 进程退出回调。stderr 为 pi 进程尾部输出（诊断信息）。 */
export type PiExitCallback = (sessionId: string, code: number | null, stderr: string) => void

/** 单个 pi 进程退出回调（IPiEngine.onExit 用）。stderr 为 pi 进程尾部输出（诊断信息）。 */
export type PiProcessExitCallback = (code: number | null, stderr: string) => void

/** createSession 的进程启动选项。 */
export interface PiSessionOptions {
  cwd?: string
  provider?: string
  model?: string
  env?: Record<string, string>
  skillPaths?: string[]
  extensionPaths?: string[]
  piCommand?: string
}

/**
 * pi 引擎 port —— 每个 session 对应一个实例（RpcClient 实现）。
 *
 * 涵盖「单个 pi 进程的全部能力」：与 pi 的命令通信 + 该进程自身的生命周期
 * （start / kill / onExit / exited）+ session 级命令（compact / clear）。
 *
 * 逃生口已关闭（W2 收口）：sendCommand/sendRaw 不再暴露，响应归一下沉到 RpcClient 内部。
 * 调用方消费语义方法（switchSession/getState/sendExtensionUiResponse 等），不再有「发任意 pi 命令」的能力。
 */
export interface IPiEngine {
  // ── 命令通信 ──
  prompt(content: string): Promise<PiMessage>
  abort(): Promise<PiMessage>
  steer(content: string): Promise<PiMessage>
  followUp(content: string): Promise<PiMessage>
  setModel(provider: string, modelId: string): Promise<PiMessage>
  setThinkingLevel(level: string): Promise<PiMessage>
  getHistory(): Promise<PiMessage>
  getCommands(): Promise<PiCommandInfo[]>
  /** 查询 pi session 统计（含 contextUsage 上下文占用估算）。用于恢复 session 后拉取当前用量。 */
  getSessionStats(): Promise<PiSessionStats>
  /** 切换 pi 进程到指定 session 文件（restore / fork 用）。 */
  switchSession(sessionPath: string): Promise<void>
  /** 查询 pi session 状态（get_state），返回归一后的 state 对象。 */
  getState(): Promise<Record<string, unknown> | undefined>
  /** 向 pi 发送 extension_ui_response（extension UI / bridge 请求的响应，pi 不回 RPC reply）。 */
  sendExtensionUiResponse(id: string, response: unknown, method?: string): void
  /** 订阅 pi 事件流。返回 unsubscribe。事件由 EventAdapter 翻译，service 一般不直接处理。 */
  onEvent(listener: PiEventListener): () => void

  // ── session 级命令 ──
  /** 压缩当前会话上下文（pi compact 命令）。customInstructions 透传给 pi 压缩 prompt。返回 CompactionResult 供 dispatcher 广播 summary + 刷新 context 用量。 */
  compact(customInstructions?: string): Promise<PiCompactionResult>
  /** 清空当前会话上下文（pi clear 命令）。 */
  clear(): Promise<PiMessage>

  // ── 进程生命周期（本进程自身） ──
  /** 启动 pi 子进程。由 ProcessManager.createSession 内部调用，service 一般不直接调。 */
  start(): Promise<void>
  /** 终止 pi 子进程（SIGTERM，超时后 SIGKILL）。 */
  kill(): Promise<void>
  /** 注册本进程退出回调。 */
  onExit(callback: PiProcessExitCallback): void
  /** 进程是否已退出。 */
  readonly exited: boolean
}

/**
 * pi 进程池 port —— session↔pi 绑定（ProcessManager 实现）。
 *
 * services 经此管理 session 的 pi 进程，getClient 返回 IPiEngine 而非 RpcClient。
 * 这是「多进程调度」视角：按 sessionId 查/建/销毁 pi 进程，是 IPiEngine 的集合管理者。
 */
export interface IProcessManager {
  /** 创建并启动一个新的 pi 进程，绑定到 sessionId。返回其 IPiEngine 句柄。 */
  createSession(sessionId: string, cwd: string, options?: PiSessionOptions): Promise<IPiEngine>
  /** 销毁 sessionId 对应的 pi 进程。 */
  destroySession(sessionId: string): Promise<void>
  /** 获取 sessionId 对应的 pi 引擎（不存在返回 undefined）。 */
  getClient(sessionId: string): IPiEngine | undefined
  /** 反查：由 pi 引擎句柄找 sessionId（不存在返回 undefined）。 */
  getSessionIdByClient(client: IPiEngine): string | undefined
  /** sessionId 是否有活跃的 pi 进程。 */
  hasClient(sessionId: string): boolean
  /** 重绑定：把 oldId 的 pi 进程改挂到 newId（fork / rebind 用）。 */
  rekey(oldId: string, newId: string): void
  /** 注册「任一 session 的进程退出」回调。返回 unsubscribe。 */
  onSessionExit(callback: PiExitCallback): () => void
  /** 销毁全部 pi 进程（关闭时清理用）。 */
  destroyAll(): Promise<void>
  /** 探测 pi 二进制版本（首次 execSync，后续读缓存）。失败返回 'unknown'。 */
  getPiVersion(): Promise<string>
}

/**
 * 兼容别名：IRpcClient === IPiEngine。
 *
 * 历史上 interfaces.ts 定义过 IRpcClient（与 ports/pi-engine.ts 的 IPiEngine 重复，
 * 见 D24）。现已合并为 IPiEngine，保留此别名让尚未迁移的 import 继续编译；
 * 新代码应直接用 IPiEngine。待调用点全量迁移后删除。
 *
 * @deprecated 改用 IPiEngine。
 */
export type IRpcClient = IPiEngine
