/**
 * useTurnElapsed —— 回合工作耗时 live 计时（从 Turn.vue 拆出，单一变化轴「elapsed 计时」）。
 *
 * 职责（纯计时关注点，原 misplaced 在展示组件 Turn.vue 内）：
 * - elapsed：streaming 态 setInterval 每秒重算 now-firstTs（live 计时）；
 *   完成态静态 lastTs-firstTs（定格）。
 * - formatElapsed：Xs / Xm SSs 格式化（含 streaming/completed 边界 + 无 assistant 兜底）。
 * - 生命周期：streaming 态挂载即 start；isStreaming true→false 停表定格；onUnmounted 清 interval 防泄漏。
 *
 * CW wave `session-active-ssot` T4 拆分两个信号：
 * - 计时器 start/stop 看 **isStreaming**（文本流式生成耗时——ask-user 等待不算生成耗时）。
 * - 完成自动收起（onComplete 回调）看 **isSessionActive**（对话真正结束才收起：
 *   ask-user 期间 message.complete 让 isStreaming false 但 session 仍 waiting，不应收起）。
 *
 * 不含：expanded 折叠态复位（trace 展示关注点，留 Turn.vue，经 onComplete 回调通知它复位）、
 * tool/thinking 计数、fork/编辑（Turn.vue 其他职责）。
 *
 * @param getAssistants 当前 turn 的 assistant 列表 getter（取首/末 timestamp 算耗时）
 * @param getIsStreaming 当前 turn 的「文本流式生成」态 getter（驱动计时器 live/静态切换）
 * @param getIsSessionActive 当前 turn 的「对话进行中」态 getter（驱动完成收起回调）。
 *   仅用于 onComplete 的触发判定（对话真正结束才收起 trace）。若不传则退化为跟随 isStreaming
 *   收起（向后兼容旧调用方）。
 * @param onComplete optional isSessionActive true→false 回调（Turn.vue 用它复位 expanded）
 */
import { ref, watch, onUnmounted, type Ref } from 'vue'
import type { Message } from '@xyz-agent/shared'

/** 时间格式化常量（elapsed 计算） */
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const SEC_PAD_WIDTH = 2

export function useTurnElapsed(
  getAssistants: () => Message[],
  getIsStreaming: () => boolean,
  getIsSessionActive?: () => boolean,
  onComplete?: () => void,
): { elapsed: Ref<string> } {
  const elapsed = ref(formatElapsed())
  let elapsedTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 计算并格式化耗时。
   * - 无 assistant → '0s' 兜底。
   * - streaming：now - 首条 timestamp（live）。
   * - completed：末条 timestamp - 首条 timestamp（定格）。最小 1s（避免 0s 抖动）。
   */
  function formatElapsed(): string {
    const as = getAssistants()
    if (as.length === 0) return '0s'
    const first = as[0].timestamp
    const end = getIsStreaming() ? Date.now() : as[as.length - 1].timestamp
    const secs = Math.max(1, Math.round((end - first) / MS_PER_SEC))
    const m = Math.floor(secs / SEC_PER_MIN)
    const s = secs % SEC_PER_MIN
    return m > 0 ? `${m}m ${String(s).padStart(SEC_PAD_WIDTH, '0')}s` : `${s}s`
  }

  function stopElapsedTimer(): void {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }

  function startElapsedTimer(): void {
    stopElapsedTimer()
    elapsed.value = formatElapsed()
    elapsedTimer = setInterval(() => {
      elapsed.value = formatElapsed()
    }, MS_PER_SEC)
  }

  // 挂载时若已 streaming 即开始 live 计时
  if (getIsStreaming()) startElapsedTimer()

  // 计时器：isStreaming true→false 停表定格，false→true 开始 live 计时。
  // 仅关注文本生成耗时，不看 ask-user 等待（ask-user 期间 message 已 complete，isStreaming=false）。
  watch(
    () => getIsStreaming(),
    (nw, old) => {
      if (old && !nw) {
        // 文本流完：停表定格
        stopElapsedTimer()
        elapsed.value = formatElapsed()
      } else if (!old && nw) {
        startElapsedTimer()
      }
    },
  )

  // 完成收起：isSessionActive true→false 触发（对话真正结束才收起 trace）。
  // ask-user 时序：streaming(isStreaming true, active true) → message.complete(isStreaming false)
  //   但 ask-user pending(active 仍 true) → respond(active false) 才收起。
  // 若未提供 getIsSessionActive（旧调用方），退化为跟随 isStreaming 收起。
  const activeGetter = getIsSessionActive ?? getIsStreaming
  if (onComplete) {
    watch(
      () => activeGetter(),
      (nw, old) => {
        if (old && !nw) onComplete()
      },
    )
  }

  onUnmounted(stopElapsedTimer)

  return { elapsed }
}
