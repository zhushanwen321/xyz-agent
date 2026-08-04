/**
 * terminal 写队列状态机 —— @xyz-agent/core 平台无关内核（headless）的写队列归位。
 *
 * 迁移自 renderer stores/terminal-write-queue.ts（W2，drawer 域向 core 归位第二步）。
 * 联动 2（AI 命令→填终端）的跨组件写队列 + PTY 存活态：
 * - 写入方（消息流 tool 块「在终端运行」）→ enqueueWrite(sid, cmd)
 * - 状态更新方（TerminalView 的 alive/exit handler）→ markAlive(sid) / markExited(sid)
 *
 * core 零 api 层依赖（C3）：write 副作用（terminalApi.write）经 writeFn 注入——
 * 调用方传 (sid, cmd) => void（renderer 兼容层传 terminalApi.write 包装）。
 * core 不 import pinia（纯 TS 状态机，Map + plain object，无 reactivity 依赖）。
 *
 * 工厂形态（per-instance sessions Map）：测试可独立构造（vi.fn() 注入 writeFn）；
 * renderer 兼容层模块级持有实例保持「跨组件共享单例」语义（原 pinia store 单例：
 * Block 写 / TerminalView flush 共享同一队列）。
 */
export interface TerminalSessionState {
  ptyAlive: boolean
  pendingWrites: string[]
}

/** 写副作用注入点：调用方决定如何把命令写入终端（renderer 侧 = terminalApi.write） */
export type TerminalWriteFn = (sid: string, cmd: string) => void

export interface TerminalWriteQueue {
  /** PTY 就绪标记（TerminalView 的 alive handler 调）+ flush 写队列。 */
  markAlive(sid: string): void
  /** PTY 退出标记（TerminalView 的 exit handler 调）。 */
  markExited(sid: string): void
  /**
   * 入队写命令（联动 2：消息流 tool 块「在终端运行」调）。
   * - PTY 已活 → 立即 write
   * - PTY 未活 → 入 pendingWrites，markAlive 时 flush
   */
  enqueueWrite(sid: string, cmd: string): void
  /** 查询 PTY 存活态（TerminalView 工具栏 kill 按钮 disabled 判断用）。 */
  isPtyAlive(sid: string): boolean
  /** session 销毁时清理（session 销毁编排点调）。 */
  removeSession(sid: string): void
}

/**
 * 创建 terminal 写队列（工厂，per-instance sessions Map）。
 *
 * @param writeFn 写副作用注入（core 零 api 层依赖）：调用方传 (sid, cmd) => void
 *                （renderer 兼容层传 terminalApi.write 包装）
 */
export function createTerminalWriteQueue(writeFn: TerminalWriteFn): TerminalWriteQueue {
  /** per-session 状态表（工厂实例内共享，跨组件共享语义由调用方持有实例保证）。 */
  const sessions = new Map<string, TerminalSessionState>()

  function getOrCreate(sid: string): TerminalSessionState {
    let s = sessions.get(sid)
    if (!s) {
      s = { ptyAlive: false, pendingWrites: [] }
      sessions.set(sid, s)
    }
    return s
  }

  function markAlive(sid: string): void {
    const s = getOrCreate(sid)
    s.ptyAlive = true
    // flush 待写命令（联动 2 入队的命令）
    for (const cmd of s.pendingWrites) {
      writeFn(sid, cmd)
    }
    s.pendingWrites = []
  }

  function markExited(sid: string): void {
    const s = sessions.get(sid)
    if (s) s.ptyAlive = false
  }

  function enqueueWrite(sid: string, cmd: string): void {
    const s = getOrCreate(sid)
    if (s.ptyAlive) {
      writeFn(sid, cmd)
    } else {
      s.pendingWrites.push(cmd)
    }
  }

  function isPtyAlive(sid: string): boolean {
    return sessions.get(sid)?.ptyAlive ?? false
  }

  function removeSession(sid: string): void {
    sessions.delete(sid)
  }

  return { markAlive, markExited, enqueueWrite, isPtyAlive, removeSession }
}
