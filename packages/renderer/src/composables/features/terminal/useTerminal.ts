/**
 * useTerminal —— drawer 集成终端的 per-session 状态 + PTY 控制（Phase 3）。
 *
 * 职责：
 * 1. per-session scrollback buffer + rAF 输出写队列 + PTY 存活态 + 命令写队列（useSessionScopedState，ADR-0049）
 * 2. 订阅 terminal.data/exit/alive（useSessionEvents），WS handler 用 updateFor 防竞态
 * 3. 对外暴露 spawn/write/resize/kill/enqueueWrite（TerminalView 调用）
 *
 * 三层生命周期解耦（设计意图）与已知缺口（W14 审查 Fix-2，2026-08）：
 * - PTY（runtime）：跟随 session（session 销毁 → destroyPty），切 terminal tab 不死
 * - scrollback buffer + 订阅（renderer）：跟随 TerminalView 组件实例——TerminalView 经
 *   v-if 挂载（PanelContainer「drawerTab === 'terminal'」分支），切走 tab 即 unmount，
 *   订阅（terminal.data → appendChunk）与 Map 分区随组件销毁，**切走期间输出不累积**
 *   （已知缺口：分区生命周期应上提到独立于组件的层，归 W27/D-6.2 处理；09 文档 E6-c 的
 *   「切走期间照常累积」前提不成立）。切回 mount 是全新分区 + 重新 spawn。
 * - xterm 组件：跟随 terminal tab 可见性（TerminalView mount/unmount）
 * 当前实际保证仅覆盖 unmount 前的同帧窗口：已调度未执行的 rAF 回调持分区引用（Fix-4），
 * unmount 后执行只写孤儿对象（不复活分区、无泄漏）；切走期间的 PTY 输出无人接收。
 *
 * rAF 输出写队列（D-6.1，2026-08 perf）：
 * - terminal.data 不再逐 chunk push scrollback，改入 outputQueue，rAF 回调 flushPending
 *   批量 append scrollback → TerminalView 的 watch(flushVersion) 每帧至多触发一次 →
 *   replayScrollback 合并为一次 xterm.write。消除「每 chunk 一次 watch + 一次 write」的高频掉帧。
 * - watch 源是 flushVersion 而非 scrollback.length：scrollback 达 SCROLLBACK_LIMIT 稳态后
 *   每次 flush「push N + splice 回 LIMIT」净值守恒，watch(() => length) 不触发 → 实时输出
 *   冻结（W14 审查 Fix-1）；flushVersion 每次有内容的 flush 单调 +1，稳定触发。
 * - 用户输入（writeToTerminal）不走此队列，直连 terminalApi.write（击键即时回显）。
 *
 * 联动 2 写队列（enqueueWrite）：
 * - PTY 已活（ptyAlive=true）→ 立即 write
 * - PTY 未活 → 入 pendingWrites，等 terminal.alive flush
 * 解决 TerminalView 首次打开时 spawn 异步、命令写入的时序问题。
 *
 * 依赖方向：useSessionScopedState + useSessionEvents + terminalApi（@/api）。
 * 必须在组件 setup 同步调用（依赖 useSessionEvents 的 onBeforeUnmount）。
 */
import { reactive, type Ref } from 'vue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'
import { terminalApi } from '@/api/domains/terminal'

/** terminal per-session 状态分区。reactive 容器（ADR-0049 契约）。 */
interface TerminalPartition {
  /** scrollback 历史输出（PTY 切走期间继续累积，切回回放）。上限由 scrollback 配置裁剪。 */
  scrollback: string[]
  /**
   * rAF 写队列（D-6.1）：一帧内待 flush 的 PTY 输出 chunk 暂存。
   * terminal.data handler 只 push 这里，等 rAF flush 时批量进 scrollback——
   * 高频输出时 N 次 data 合并为每帧一次 scrollback 批量 append + 一次 xterm.write。
   * 命名避开 terminal-write-queue 的 pendingWrites（那是命令队列，drop-oldest 语义）。
   */
  outputQueue: string[]
  /** rAF 是否已置位（per-sid 防重入：置位期间新 chunk 只入队不再调度）。 */
  rafPending: boolean
  /**
   * flush 版本号（单调递增，W14 审查 Fix-1）：每次「有内容的 flush」自增 1。
   * TerminalView 的 watch 源——scrollback 稳态轮转（达 LIMIT 后 push N + splice N）时
   * length 净值守恒，watch(() => length) 不触发；flushVersion 恒变，watch 稳定触发。
   * 兼为 W27/D-6.2 版本回放的锚点（replay(fromVersion) 的版本基准，见 09 §3.3.1 第二步）。
   */
  flushVersion: number
  /**
   * 累计 append 进 scrollback 的 chunk 总数（单调递增，裁剪不减，W14 审查 Fix-1）。
   * 回放指针的「逻辑索引」基准：逻辑索引 - (totalAppended - scrollback.length) = 物理索引。
   * 轮转后物理 length 净值守恒、绝对物理索引失义，只有逻辑指针能稳定指向未回放的尾部。
   */
  totalAppended: number
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
    outputQueue: [],
    rafPending: false,
    flushVersion: 0,
    totalAppended: 0,
    ptyAlive: false,
    cols: 80,
    rows: 24,
  })
}

/** scrollback 上限（Phase 6 后由 settings 配置，当前固定 5000）。 */
const SCROLLBACK_LIMIT = 5000

/**
 * outputQueue 防御上限（E6-a）：rAF 被后台节流（窗口最小化/隐藏）长时间不触发时，
 * 队列按 join 合并成单块而非丢弃——输出侧语义是「保序全量」，丢 chunk 会在历史留空洞。
 * 与命令队列 terminal-write-queue 的 drop-oldest（保最新命令）语义刻意分离。
 */
const MAX_OUTPUT_QUEUE = 1000

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

  // terminal.data：PTY 输出 → 入 rAF 写队列（updateFor capturedSid，D-6.1 批量合帧）
  onMessage('terminal.data', (msg, sid) => {
    appendChunk(sid, msg.payload.data)
  })

  /**
   * terminal.data chunk 入队（D-6.1 rAF 写队列入口）。
   * 只 push 进 outputQueue 并置位 rAF；scrollback 累积与 xterm 写入都推迟到 flush——
   * 高频输出（如 build 日志）时 N 次 data 只产生每帧一次的 watch 触发 + 一次 xterm.write。
   * E6-a：rAF 被后台节流导致队列超限时 join 合并成单块（保序全量，不丢弃）。
   */
  function appendChunk(sid: string, chunk: string): void {
    let schedule = false
    let partition: TerminalPartition | null = null
    state.updateFor(sid, (s) => {
      // updater 同步执行，schedule 为 true 时 partition 必已赋值
      partition = s
      s.outputQueue.push(chunk)
      if (s.outputQueue.length > MAX_OUTPUT_QUEUE) {
        s.outputQueue = [s.outputQueue.join('')]
      }
      if (!s.rafPending) {
        s.rafPending = true
        schedule = true
      }
    })
    const p = partition
    if (schedule && p !== null) {
      // rAF 回调捕获分区引用而非 sid（W14 审查 Fix-4）：session 销毁
      // （triggerSessionCleanups 删分区）后迟到的回调只写孤儿对象（随 GC 回收），
      // 若按 sid 走 updateFor 会经 getOrCreatePartition 重建空分区（复活）。
      requestAnimationFrame(() => flushPending(p))
    }
  }

  /**
   * rAF 回调：把 outputQueue 批量刷进 scrollback（D-6.1）。
   * scrollback 是唯一累积点，但「组件切走时本函数照常累积」不成立（W14 审查 Fix-2）——
   * TerminalView 是 v-if 挂载，切走即 unmount，terminal.data 订阅随组件销毁，切走期间无输出
   * 进入本函数；本函数只覆盖 unmount 前已调度的同帧窗口（持分区引用写孤儿对象，不复活分区，
   * 分区生命周期上提归 W27/D-6.2）。xterm 写入不经本函数，由 TerminalView 的
   * watch(flushVersion) → replayScrollback 承接：每帧一次批量 append 只触发一次 watch、
   * 一次合并 write（该 watch 从此只承载「flush 后写 buffer」单一职责，09 §5 检查点）。
   * 逐 chunk push（非整体 join）保持回放粒度，为 W27/D-6.2 版本回放留语义。
   */
  function flushPending(s: TerminalPartition): void {
    s.rafPending = false
    if (s.outputQueue.length === 0) return
    for (const queued of s.outputQueue) {
      s.scrollback.push(queued)
    }
    s.totalAppended += s.outputQueue.length
    s.outputQueue.length = 0
    // 裁剪 scrollback 上限（保留最新 N chunk，语义同改造前的 per-push 裁剪）
    if (s.scrollback.length > SCROLLBACK_LIMIT) {
      s.scrollback.splice(0, s.scrollback.length - SCROLLBACK_LIMIT)
    }
    // 有内容的 flush 完成，bump 版本触发 TerminalView 的 watch（W27 版本回放锚点）
    s.flushVersion += 1
  }

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
