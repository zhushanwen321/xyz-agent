import { ref, onBeforeUnmount } from 'vue'

/**
 * 定时器 composable：streaming 时持续更新 now，complete 时停止。
 * 多个组件共享，避免 timer 逻辑重复。
 */
const DEFAULT_INTERVAL_MS = 200

export function useLiveTimer(intervalMs = DEFAULT_INTERVAL_MS) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined

  function start() {
    now.value = Date.now()
    if (!timer) timer = setInterval(() => { now.value = Date.now() }, intervalMs)
  }

  function stop() {
    if (timer !== undefined) { clearInterval(timer); timer = undefined }
  }

  // CONSTRAINT: onBeforeUnmount only works when called during Vue component setup().
  // If used outside setup (e.g. plain .ts utility), caller must manually call stop().
  onBeforeUnmount(stop)

  return { now, start, stop }
}
