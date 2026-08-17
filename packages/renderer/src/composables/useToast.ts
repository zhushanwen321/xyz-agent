/**
 * useToast —— 全局 toast 通知（最小实现）。
 *
 * 使用方式：
 *   const { toasts, error } = useToast()
 *   error('操作失败')
 *
 * ToastContainer 组件负责渲染，App.vue 挂载。
 */
import { ref } from 'vue'

export interface Toast {
  id: number
  message: string
  type: 'error' | 'info' | 'warning'
}

const toasts = ref<Toast[]>([])
let nextId = 0

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

export function useToast() {
  function error(message: string): void {
    const id = nextId++
    toasts.value = [...toasts.value, { id, message, type: 'error' }]
    scheduleRemove(id)
  }

  function info(message: string): void {
    const id = nextId++
    toasts.value = [...toasts.value, { id, message, type: 'info' }]
    scheduleRemove(id)
  }

  function warning(message: string): void {
    const id = nextId++
    toasts.value = [...toasts.value, { id, message, type: 'warning' }]
    scheduleRemove(id)
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

  return { toasts, error, info, warning, remove }
}
