import { onScopeDispose, ref } from 'vue'

/**
 * session 切换后的 settling 窗口。
 *
 * 用途：切换瞬间视口本就该重新到底，期间 delta 补偿（为保持视口稳定而设计）反而与
 * scrollToBottom 跟随竞争——实测 < 估算时负 delta 把 scrollTop 往上拉，与跟随到底打架，
 * 结果不确定。settling 期间让调用方跳过 delta 施加，由 scrollToBottom 跟随主导贴底。
 *
 * 生命周期：startSettling() 置 true，经连续 2 个 requestAnimationFrame（覆盖 1-2 轮 RO 实测
 * → flushHeightReports → delta watch flush:post）后翻 false 恢复正常锚定补偿。scope 销毁时
 * 取消 pending rAF 防泄漏。
 */
export function useSettlingGuard(): {
  settling: Readonly<ReturnType<typeof ref<boolean>>>
  startSettling: () => void
  } {
  const settling = ref(false)
  let raf1 = 0
  let raf2 = 0

  function startSettling(): void {
    settling.value = true
    cancelAnimationFrame(raf1)
    cancelAnimationFrame(raf2)
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        settling.value = false
        raf1 = 0
        raf2 = 0
      })
    })
  }

  onScopeDispose(() => {
    cancelAnimationFrame(raf1)
    cancelAnimationFrame(raf2)
  })

  return { settling, startSettling }
}
