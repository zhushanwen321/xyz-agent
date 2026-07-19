import { ref } from 'vue'

/** SearchModal 打开参数：可指定初始搜索词 */
export interface OpenSearchModalOptions {
  query?: string
}

// ── 模块级单实例状态（Q2=A：与 useSideDrawer 同构，跨 useSearchModal() 调用共享）──
/** 浮层开关 */
const isOpen = ref(false)
/** 初始/当前搜索词（打开时设置） */
const query = ref('')

/**
 * 重置 SearchModal 单实例状态（测试隔离用）。
 * 单实例状态跨 useSearchModal() 调用共享，测试需在 beforeEach 重置避免串扰。
 */
export function resetSearchModal(): void {
  isOpen.value = false
  query.value = ''
}

export function useSearchModal() {
  /** 打开搜索浮层，可指定初始 query */
  function open(initialQuery?: string): void {
    if (initialQuery !== undefined) query.value = initialQuery
    isOpen.value = true
  }

  /** 关闭搜索浮层 */
  function close(): void {
    query.value = ''
    isOpen.value = false
  }

  /** 切换开关 */
  function toggle(): void {
    if (isOpen.value) close()
    else open()
  }

  return {
    isOpen,
    query,
    open,
    close,
    toggle,
  }
}
