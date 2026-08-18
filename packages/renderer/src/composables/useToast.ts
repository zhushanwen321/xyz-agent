/**
 * useToast —— 全局 toast 通知（最小实现）。
 *
 * 使用方式：
 *   const { toasts, error } = useToast()
 *   error('操作失败')
 *
 * ToastContainer 组件负责渲染，App.vue 挂载。
 *
 * 在列上限（D7 S3-W4 限流与防毒化）：在列 toast 达到 UI_TOAST_LIMITS.MAX_IN_FLIGHT
 * （shared SSOT，默认 5）时新 toast 丢弃并累计 droppedCount——通知风暴（恶意/缺陷
 * 插件高频 notify）不刷屏，runtime 侧 20/s 令牌桶是第一道防线，此处是前端兜底。
 */
import { ref } from 'vue'
import { UI_TOAST_LIMITS } from '@xyz-agent/shared'

export interface Toast {
  id: number
  message: string
  type: 'error' | 'info' | 'warning'
}

const toasts = ref<Toast[]>([])
let nextId = 0

/** 因在列上限被丢弃的 toast 累计计数（可观测：排查通知风暴的量级证据） */
const droppedCount = ref(0)

const TOAST_DURATION_MS = 4000

/** [Q1-8] toast 自动移除 timer 句柄：remove 提前关 toast 时 clearTimeout，避免 4s 后空跑回调 */
const timers = new Map<number, ReturnType<typeof setTimeout>>()

/** 自动移除 toast（4s 后），记录句柄供 remove 清理 */
function scheduleRemove(id: number): void {
  const timer = setTimeout(() => {
    timers.delete(id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, TOAST_DURATION_MS)
  timers.set(id, timer)
}

/** 限流策略类型：返回 true 表示应丢弃当前 toast */
type ToastLimiter = (toasts: Toast[]) => boolean

const defaultLimiter: ToastLimiter = (toasts) => toasts.length >= UI_TOAST_LIMITS.MAX_IN_FLIGHT
let activeLimiter: ToastLimiter = defaultLimiter

/** 注入自定义限流策略（测试用）。传 null 恢复默认。 */
export function setToastLimiter(custom: ToastLimiter | null): void {
  activeLimiter = custom ?? defaultLimiter
}

/** 入列公共路径：在列上限守门（超出丢弃计数 + warn，防风暴刷屏） */
function push(type: Toast['type'], message: string): void {
  if (activeLimiter(toasts.value)) {
    droppedCount.value += 1
    console.warn(
      `[toast] dropped (in-flight limit ${UI_TOAST_LIMITS.MAX_IN_FLIGHT}, total dropped ${droppedCount.value}): ${message}`,
    )
    return
  }
  const id = nextId++
  toasts.value = [...toasts.value, { id, message, type }]
  scheduleRemove(id)
}

export function useToast() {
  function error(message: string): void {
    push('error', message)
  }

  function info(message: string): void {
    push('info', message)
  }

  function warning(message: string): void {
    push('warning', message)
  }

  function remove(id: number): void {
    // [Q1-8] 提前关闭时清掉自动移除 timer（句柄不存在 = 已自然触发，no-op）
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  return { toasts, error, info, warning, remove, droppedCount }
}
