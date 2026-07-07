/**
 * useTurnElapsed —— 回合工作耗时 live 计时（从 Turn.vue 拆出，单一变化轴「elapsed 计时」）。
 *
 * 职责（纯计时关注点，原 misplaced 在展示组件 Turn.vue 内）：
 * - elapsed：working 态 setInterval 每秒重算 now-firstTs（live 计时）；
 *   完成态静态 lastTs-firstTs（定格）。
 * - formatElapsed：Xs / Xm SSs 格式化（含 working/completed 边界 + 无 assistant 兜底）。
 * - 生命周期：working 态挂载即 start；isWorking true→false 停表定格；onUnmounted 清 interval 防泄漏。
 *
 * 不含：expanded 折叠态复位（trace 展示关注点，留 Turn.vue，经 onComplete 回调通知它复位）、
 * tool/thinking 计数、fork/编辑（Turn.vue 其他职责）。
 *
 * @param getAssistants 当前 turn 的 assistant 列表 getter（取首/末 timestamp 算耗时）
 * @param getIsWorking 当前 turn 的 working 态 getter（驱动 live/静态切换）
 * @param onComplete optional isWorking true→false 回调（Turn.vue 用它复位 expanded）
 */
import { ref, watch, onUnmounted, type Ref } from 'vue'
import type { Message } from '@xyz-agent/shared'

/** 时间格式化常量（elapsed 计算） */
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const SEC_PAD_WIDTH = 2

export function useTurnElapsed(
  getAssistants: () => Message[],
  getIsWorking: () => boolean,
  onComplete?: () => void,
): { elapsed: Ref<string> } {
  const elapsed = ref(formatElapsed())
  let elapsedTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 计算并格式化耗时。
   * - 无 assistant → '0s' 兜底。
   * - working：now - 首条 timestamp（live）。
   * - completed：末条 timestamp - 首条 timestamp（定格）。最小 1s（避免 0s 抖动）。
   */
  function formatElapsed(): string {
    const as = getAssistants()
    if (as.length === 0) return '0s'
    const first = as[0].timestamp
    const end = getIsWorking() ? Date.now() : as[as.length - 1].timestamp
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

  // 挂载时若已 working 即开始 live 计时
  if (getIsWorking()) startElapsedTimer()

  // isWorking true→false：完成定格（停表 + 终值）；false→true：开始 live 计时。
  // 完成时通知调用方（Turn.vue 复位 expanded，原 watch 合并语义保留）。
  watch(
    () => getIsWorking(),
    (nw, old) => {
      if (old && !nw) {
        // 完成：停表定格
        stopElapsedTimer()
        elapsed.value = formatElapsed()
        onComplete?.()
      } else if (!old && nw) {
        startElapsedTimer()
      }
    },
  )

  onUnmounted(stopElapsedTimer)

  return { elapsed }
}
