import { ref, onBeforeUnmount } from 'vue'

/**
 * 定时器 composable：streaming 时持续更新 now，complete 时停止。
 * 多个组件共享，避免 timer 逻辑重复。
 */
export function useLiveTimer(intervalMs = 200) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined

  function start() {
    now.value = Date.now()
    if (!timer) timer = setInterval(() => { now.value = Date.now() }, intervalMs)
  }

  function stop() {
    if (timer !== undefined) { clearInterval(timer); timer = undefined }
  }

  onBeforeUnmount(stop)

  return { now, start, stop }
}
