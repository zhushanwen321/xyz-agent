/**
 * useTerminal —— drawer 集成终端的 per-session 状态 + PTY 控制（Phase 3）。
 *
 * 职责：
 * 1. per-session scrollback buffer + PTY 存活态 + 写队列（useSessionScopedState，ADR-0036）
 * 2. 订阅 terminal.data/exit/alive（useSessionEvents），WS handler 用 updateFor 防竞态
 * 3. 对外暴露 spawn/write/resize/kill/enqueueWrite（TerminalView 调用）
 *
 * 三层生命周期解耦（核心设计）：
 * - PTY（runtime）：跟随 session（session 销毁 → destroyPty）
 * - scrollback buffer（renderer Map 分区）：跟随 session（useSessionScopedState 分区）
 * - xterm 组件：跟随 terminal tab 可见性（TerminalView mount/unmount）
 * 切走 terminal tab 时 xterm unmount，但 PTY + buffer 不动；切回 mount 时回放 buffer。
 * WS handler 无条件 append scrollback（updateFor capturedSid），切走期间输出不丢。
 *
 * 联动 2 写队列（enqueueWrite）：
 * - PTY 已活（ptyAlive=true）→ 立即 write
 * - PTY 未活 → 入 pendingWrites，等 terminal.alive flush
 * 解决 TerminalView 首次打开时 spawn 异步、命令写入的时序问题。
 *
 * [wave3 seq 回放去重] 重连清缓冲（spec §6.3）：WS 重连后 server 全量回灌 terminal.data
 * 会与断线前本地累积的 scrollback 重复显示。useTerminal setup 内 watch 全局重连信号
 *（useReconnectEpoch），信号变化时清当前 sid 分区 scrollback（保留 reactive 容器 +
 * ptyAlive/cols/rows 不动）。信号由 useConnection 重连成功时 bumpReconnectEpoch 触发。
 *
 * 依赖方向：useSessionScopedState + useSessionEvents + terminalApi（@/api）
 * + terminal-reconnect-signal（重连信号 watch）。
 * 必须在组件 setup 同步调用（依赖 useSessionEvents 的 onBeforeUnmount）。
 */
import { reactive, watch, type Ref } from 'vue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useSessionEvents } from '@/composables/features/useSessionEvents'
import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'
import { terminalApi } from '@/api/domains/terminal'
import { useReconnectEpoch } from '@/lib/terminal-reconnect-signal'

/** terminal per-session 状态分区。reactive 容器（ADR-0036 契约）。 */
interface TerminalPartition {
  /** scrollback 历史输出（PTY 切走期间继续累积，切回回放）。上限由 scrollback 配置裁剪。 */
  scrollback: string[]
  /** PTY 是否存活（spawn 后置 true，exit 后置 false）。联动 2 的 ptyAlive 判断在全局 store（terminal-write-queue）。 */
  ptyAlive: boolean
  /** 当前 PTY 尺寸（xterm fit 后记录）。 */
  cols: number
  rows: number
}

/** 新分区的默认状态。 */
function createPartition(): TerminalPartition {
  return reactive({
    scrollback: [],
    ptyAlive: false,
    cols: 80,
    rows: 24,
  })
}

/** scrollback 上限（Phase 6 后由 settings 配置，当前固定 5000）。 */
const SCROLLBACK_LIMIT = 5000

/**
 * terminal per-session 状态 + PTY 控制。
 *
 * @param sessionIdRef session id ref（string | null）
 * @returns 状态（current computed）+ PTY 控制（spawn/write/resize/kill）+ 写队列（enqueueWrite）
 */
export function useTerminal(sessionIdRef: Ref<string | null>) {
  const state = useSessionScopedState(sessionIdRef, createPartition)
  const writeQueue = useTerminalWriteQueueStore()

  // 订阅 terminal.* 广播（useSessionEvents 管理 session 级订阅生命周期）
  const onMessage = useSessionEvents(sessionIdRef)

  // terminal.data：PTY 输出 → append scrollback（无条件，切走也不丢输出）
  onMessage('terminal.data', (msg, sid) => {
    state.updateFor(sid, (s) => {
      s.scrollback.push(msg.payload.data)
      // 裁剪 scrollback 上限（保留最新 N 行）
      if (s.scrollback.length > SCROLLBACK_LIMIT) {
        s.scrollback.splice(0, s.scrollback.length - SCROLLBACK_LIMIT)
      }
    })
  })

  // terminal.alive：PTY 就绪 → 置 ptyAlive + markAlive（flush 全局写队列，联动 2）
  onMessage('terminal.alive', (_msg, sid) => {
    state.updateFor(sid, (s) => {
      s.ptyAlive = true
    })
    // store.markAlive 同步 ptyAlive + flush 写队列（Block.vue 入队的命令）
    writeQueue.markAlive(sid)
  })

  // terminal.exit：PTY 退出 → 置 ptyAlive=false + markExited
  onMessage('terminal.exit', (_msg, sid) => {
    state.updateFor(sid, (s) => {
      s.ptyAlive = false
    })
    writeQueue.markExited(sid)
  })

  /**
   * 清指定 session 分区的 scrollback（wave3 P2-s4 IF5，spec §6.3）。
   *
   * splice(0) 清空数组保留 reactive 容器（下游 computed 依赖不丢）。不清 ptyAlive/cols/rows
   *（这些是 PTY 状态非缓冲数据，重连后 PTY 重新 spawn 会重置）。
   *
   * 触发点：(1) 全局重连信号 watch（下方）—— WS 重连成功后清当前 sid 分区，防 server 回灌
   * 与本地缓冲重复显示；(2) 测试直接调用断言。
   */
  function clearScrollback(sessionId: string): void {
    state.updateFor(sessionId, (s) => {
      s.scrollback.splice(0)
    })
  }

  // wave3 P2-s4：watch 全局重连信号，重连成功时清当前 sid 分区 scrollback。
  // 信号由 useConnection 重连成功（getState 非 connected→connected）bumpReconnectEpoch 触发。
  // watch 跟随 setup 的 effect scope（组件卸载自动清理，与 useSessionEvents 同模式）。
  watch(useReconnectEpoch(), () => {
    const sid = sessionIdRef.value
    if (sid) clearScrollback(sid)
  })

  /** 创建 PTY（TerminalView mount 且 !ptyAlive 时调）。cwd 取 session.cwd。 */
  async function spawnTerminal(cwd: string | undefined, cols: number, rows: number): Promise<void> {
    const sid = sessionIdRef.value
    if (!sid) return
    // 先记录尺寸
    state.update((s) => { s.cols = cols; s.rows = rows })
    await terminalApi.spawn({ sessionId: sid, cwd, cols, rows })
    // 注：ptyAlive 由 terminal.alive 广播置位（异步），这里不等
  }

  /** 写入字节（用户输入）。TerminalView 的 xterm.onData 调。 */
  function writeToTerminal(data: string): void {
    const sid = sessionIdRef.value
    if (!sid) return
    void terminalApi.write(sid, data)
  }

  /** 调整尺寸（xterm fit addon 触发）。 */
  function resizeTerminal(cols: number, rows: number): void {
    const sid = sessionIdRef.value
    if (!sid) return
    state.update((s) => { s.cols = cols; s.rows = rows })
    void terminalApi.resize(sid, cols, rows)
  }

  /** kill PTY（工具栏 kill 按钮）。 */
  function killTerminal(): void {
    const sid = sessionIdRef.value
    if (!sid) return
    void terminalApi.kill(sid)
  }

  /** 通知 PTY 活跃（TerminalView mount 调，预留流量控制）。 */
  function attachTerminal(): void {
    const sid = sessionIdRef.value
    if (!sid) return
    void terminalApi.attach(sid)
  }

  return {
    /** 当前 sid 分区状态（null sid 返回默认实例）。 */
    current: state.current,
    /** PTY 控制方法。 */
    spawnTerminal,
    writeToTerminal,
    resizeTerminal,
    killTerminal,
    attachTerminal,
  }
}

/** useTerminal 返回类型（供组件 type import）。 */
export type UseTerminalReturn = ReturnType<typeof useTerminal>
