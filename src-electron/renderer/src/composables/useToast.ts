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
  type: 'error' | 'info'
}

const toasts = ref<Toast[]>([])
let nextId = 0

const TOAST_DURATION_MS = 4000

/** 自动移除 toast（4s 后） */
function scheduleRemove(id: number): void {
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, TOAST_DURATION_MS)
}

export function useToast() {
  function error(message: string): void {
    const id = nextId++
    toasts.value = [...toasts.value, { id, message, type: 'error' }]
    scheduleRemove(id)
  }

  function remove(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  return { toasts, error, remove }
}
