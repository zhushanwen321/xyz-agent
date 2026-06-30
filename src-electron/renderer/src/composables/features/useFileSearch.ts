/**
 * useFileSearch —— composer `#` 文件候选的前端编排（session 级缓存 + debounce + 失效）。
 *
 * 职责（单一变化轴「composer 文件候选加载编排」）：
 * - load：缓存命中直接返回，否则调 composer.getFileCandidates + 写 store
 * - debouncedLoad：debounce 包装（300ms），防浮层快速开关/输入抖动重复请求
 * - setupInvalidation：watch chatStore fileChanges 变化 → store.invalidate（G9：删缓存不重拉）
 *
 * 范式对称 useFileTree（同属 composables/features，跨 store 编排在 composable 层 watch，
 * stores 间禁止 import）。
 *
 * 依赖方向：useFileSearch → fileSearchStore + api/composer + chatStore（watch only）。
 */
import { watch, type Ref } from 'vue'
import { useFileSearchStore } from '@/stores/fileSearch'
import { useChatStore } from '@/stores/chat'
import { composer as composerApi } from '@/api'
import type { FileNode } from '@xyz-agent/shared'

/** debounce 延迟（ms），防浮层开关/输入抖动重复触发全量递归 */
const DEBOUNCE_MS = 300

export function useFileSearch() {
  const store = useFileSearchStore()

  /**
   * 加载 session 的文件候选（缓存优先）。
   * - 缓存命中 → 直接返回（不重新递归）
   * - 未缓存 → 调 composer.getFileCandidates（file.search）+ 写 store
   * @returns FileNode[]（缓存或新拉取；失败返回空数组，不抛——浮层降级为空态）
   */
  async function load(sessionId: string): Promise<FileNode[]> {
    const cached = store.get(sessionId)
    if (cached) return cached
    try {
      const nodes = await composerApi.getFileCandidates(sessionId)
      store.set(sessionId, nodes)
      return nodes
    } catch {
      // file.search 失败（session 不存在/transport 断连）→ 降级空数组，浮层显空态
      // 不缓存失败结果（下次 load 仍尝试），不抛（CommandPopover.loadCandidates 用 allSettled）
      return []
    }
  }

  /** debounce 包装的 load（防抖动重复请求）。返回 cancel 函数（组件卸载时调） */
  function debouncedLoad(sessionId: string, onResult: (nodes: FileNode[]) => void): () => void {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      void load(sessionId).then(onResult)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }

  /**
   * 跨 store 失效编排（G9）：watch chatStore 该 session 的 fileChanges 变化
   * → store.invalidate（删缓存，不重拉）。
   *
   * 复用 useFileTree.setupInvalidation 模式：composable 层 watch（stores 间禁止 import，
   * 但 composable 可 watch 多个 store）。fileChanges 变化 = agent 改了文件 → 缓存过期，
   * 下次 load 重拉。
   *
   * @param sessionIdRef session id 的 ref（变化时重订阅）
   * @returns unwatch 函数（组件 onBeforeUnmount 调用，避免泄漏）
   */
  function setupInvalidation(sessionIdRef: Ref<string>): () => void {
    const chatStore = useChatStore()
    let lastPaths = new Set<string>()

    const unwatch = watch(
      [() => sessionIdRef.value, () => chatStore.messages],
      () => {
        const sid = sessionIdRef.value
        if (!sid) {
          lastPaths = new Set()
          return
        }
        const msgs = chatStore.getMessages(sid)
        const currentPaths = new Set<string>()
        for (const m of msgs) {
          if (m.role !== 'assistant') continue
          for (const fc of m.fileChanges ?? []) {
            currentPaths.add(fc.filePath)
          }
        }
        const changed = [...currentPaths].filter((p) => !lastPaths.has(p))
        if (changed.length > 0) {
          store.invalidate(sid)
        }
        lastPaths = currentPaths
      },
      { deep: true, immediate: true },
    )

    return unwatch
  }

  return { load, debouncedLoad, setupInvalidation }
}
