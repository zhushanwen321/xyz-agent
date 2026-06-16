import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ToastAction, ToastItem } from '../components/toast/ToastContainer.vue'

const TOAST_DURATION_MS = 4_000
const TOAST_LONG_DURATION_MS = 8_000

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<ToastItem[]>([])
  // 模块级 timer 表，store 单例，随 pinia 生命周期常驻
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function dismiss(id: string) {
    toasts.value = toasts.value.filter(t => t.id !== id)
    const tm = timers.get(id)
    if (tm) {
      clearTimeout(tm)
      timers.delete(id)
    }
  }

  /**
   * 展示一条 toast。返回 id，调用方可持有后手动 dismiss。
   * - long: 用 8s 时长（默认 4s）
   * - persistent: 不自动消失，必须调用方手动 dismiss（如"断连直到重连"）
   */
  function show(opts: {
    type: ToastItem['type']
    title: string
    description?: string
    actions?: ToastAction[]
    long?: boolean
    persistent?: boolean
  }): string {
    const id = crypto.randomUUID()
    toasts.value.push({
      id,
      type: opts.type,
      title: opts.title,
      description: opts.description,
      actions: opts.actions,
    })
    if (!opts.persistent) {
      const ms = opts.long ? TOAST_LONG_DURATION_MS : TOAST_DURATION_MS
      timers.set(id, setTimeout(() => dismiss(id), ms))
    }
    return id
  }

  return { toasts, show, dismiss }
})
