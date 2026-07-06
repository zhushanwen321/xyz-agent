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
 * pi 的 sendCommand 响应结构是动态的（get_state/fork/getHistory 各不相同），
 * 无法用单一精确类型描述。services 用 `as PiMessage` 后再 `as` 具体结构——
 * 这是「类型系统对 pi 动态响应认输」的诚实标注，不是协议泄露。
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

/** pi 进程退出回调。 */
export type PiExitCallback = (sessionId: string, code: number | null) => void

/** 单个 pi 进程退出回调（IPiEngine.onExit 用）。 */
export type PiProcessExitCallback = (code: number | null) => void

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
 * sendCommand 是逃生方法：返回 PiMessage(unknown)，调用方自行 as 具体结构。
 * 这是刻意的——pi 的命令响应结构动态，精确化收益低且要跟 pi 改。
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
  /** 逃生方法：发送任意 pi 命令，返回动态响应。调用方自行 as 具体结构。 */
  sendCommand(type: string, params?: Record<string, unknown>, timeout?: number): Promise<PiMessage>
  /** 订阅 pi 事件流。返回 unsubscribe。事件由 EventAdapter 翻译，service 一般不直接处理。 */
  onEvent(listener: PiEventListener): () => void

  // ── session 级命令 ──
  /** 压缩当前会话上下文（pi compact 命令）。customInstructions 透传给 pi 压缩 prompt。 */
  compact(customInstructions?: string): Promise<PiMessage>
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

// ── pi RPC 响应解析 helpers（D16 收口）──────────────────────────
//
// pi 的 RPC 响应兼容两种字段位置（`data` 或 `payload`），历史上每处调用都重复
// `resp.data ?? resp.payload` + `as PiStateResponse`。以下 helper 收敛该样板。

/** pi RPC 响应的通用形状（data 或 payload 二选一承载结果）。 */
export interface PiRpcResponse {
  data?: Record<string, unknown>
  payload?: Record<string, unknown>
}

/** pi get_state 响应结构（动态 JSON，逃生断言）。 */
export type PiStateResponse = PiRpcResponse

/**
 * 从 pi RPC 响应取归一化的结果对象（兼容 data/payload 两位置）。
 * 用于 get_state/get_commands 等返回单层对象的命令。
 */
export function readRpcData(resp: PiRpcResponse): Record<string, unknown> | undefined {
  return resp.data ?? resp.payload
}

/**
 * 发 get_state 并返回归一化后的 state 对象（兼容 data/payload）。
 * 消除 session-lifecycle 等处重复的
 * `await client.sendCommand('get_state') as PiStateResponse; resp.data ?? resp.payload`。
 */
export async function readPiState(client: IPiEngine): Promise<Record<string, unknown> | undefined> {
  return readRpcData(await client.sendCommand('get_state') as PiStateResponse)
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
