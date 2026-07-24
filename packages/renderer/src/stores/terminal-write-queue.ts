/**
 * terminal-write-queue store —— 联动 2（AI 命令→填终端）的跨组件写队列 + PTY 存活态。
 *
 * ## 背景
 * useTerminal（TerminalView 持有）用 useSessionScopedState 维护 per-session scrollback，但分区 Map
 * 是 per-instance（ADR-0036）。Block.vue（消息流 tool 块）需要 enqueueWrite 但不应调 useTerminal
 * （会建独立 partition + 重复订阅 alive）。
 *
 * 解法：ptyAlive + pendingWrites 做成全局 Pinia store（单例），Block.vue 和 TerminalView 共享：
 * - Block「在终端运行」→ enqueueWrite（ptyAlive 判断：已活立即 write / 未活入队）
 * - TerminalView 的 alive handler → markAlive + flush 队列
 *
 * scrollback 仍是 per-instance（TerminalView 独有的视图状态），不进本 store。
 *
 * ## 数据流
 * 写入方（Block.vue）→ enqueueWrite(sid, cmd)
 * 状态更新方（TerminalView useTerminal alive handler）→ markAlive(sid) + flush(sid)
 */
import { defineStore } from 'pinia'
import { terminalApi } from '@/api/domains/terminal'

/** per-session 状态：PTY 存活 + 写队列。 */
interface TerminalSessionState {
  ptyAlive: boolean
  pendingWrites: string[]
}

export const useTerminalWriteQueueStore = defineStore('terminal-write-queue', () => {
  /** per-session 状态表（全局单例，跨组件共享）。 */
  const sessions = new Map<string, TerminalSessionState>()

  function getOrCreate(sid: string): TerminalSessionState {
    let s = sessions.get(sid)
    if (!s) {
      s = { ptyAlive: false, pendingWrites: [] }
      sessions.set(sid, s)
    }
    return s
  }

  /** PTY 就绪标记（TerminalView 的 alive handler 调）+ flush 写队列。 */
  function markAlive(sid: string): void {
    const s = getOrCreate(sid)
    s.ptyAlive = true
    // flush 待写命令（联动 2 入队的命令）
    for (const cmd of s.pendingWrites) {
      void terminalApi.write(sid, cmd)
    }
    s.pendingWrites = []
  }

  /** PTY 退出标记（TerminalView 的 exit handler 调）。 */
  function markExited(sid: string): void {
    const s = sessions.get(sid)
    if (s) s.ptyAlive = false
  }

  /**
   * 入队写命令（联动 2：Block「在终端运行」调）。
   * - PTY 已活 → 立即 write
   * - PTY 未活 → 入 pendingWrites，markAlive 时 flush
   */
  function enqueueWrite(sid: string, cmd: string): void {
    const s = getOrCreate(sid)
    if (s.ptyAlive) {
      void terminalApi.write(sid, cmd)
    } else {
      s.pendingWrites.push(cmd)
    }
  }

  /** 查询 PTY 存活态（TerminalView 工具栏 kill 按钮 disabled 判断用）。 */
  function isPtyAlive(sid: string): boolean {
    return sessions.get(sid)?.ptyAlive ?? false
  }

  /** session 销毁时清理（useSessionScopedState cleanup 可选调）。 */
  function removeSession(sid: string): void {
    sessions.delete(sid)
  }

  return { markAlive, markExited, enqueueWrite, isPtyAlive, removeSession }
})
