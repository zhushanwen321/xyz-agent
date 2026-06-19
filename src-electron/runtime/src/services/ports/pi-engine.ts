/**
 * Pi Engine 域 ports —— pi 引擎交互 + 进程池管理。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/rpc-client.ts + process-manager.ts 实现。
 * services 经此与 pi 交互，不直接持有 RpcClient/ProcessManager 具体类。
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

/**
 * pi 引擎 port —— 每个 session 对应一个实例（RpcClient 实现）。
 *
 * sendCommand 是逃生方法：返回 PiMessage(unknown)，调用方自行 as 具体结构。
 * 这是刻意的——pi 的命令响应结构动态，精确化收益低且要跟 pi 改。
 */
export interface IPiEngine {
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
}

/**
 * pi 进程池 port —— session↔pi 绑定（ProcessManager 实现）。
 * services 经此管理 session 的 pi 进程，getClient 返回 IPiEngine 而非 RpcClient。
 */
export interface IPiProcess {
  createSession(sessionId: string, cwd: string, options?: unknown): Promise<IPiEngine>
  destroySession(sessionId: string): Promise<void>
  getClient(sessionId: string): IPiEngine | undefined
  hasClient(sessionId: string): boolean
  onSessionExit(callback: PiExitCallback): () => void
}
