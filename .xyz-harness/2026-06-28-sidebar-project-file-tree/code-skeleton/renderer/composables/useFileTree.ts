/**
 * code-skeleton/renderer/composables/useFileTree.ts — 文件树交互编排（⑤code-arch §3，#3 + K-9 跨 store 编排）
 *
 * 职责：loadTree / expandNode / selectFile / setFilter（debounce）+ invalidateOnFileChanges（K-9 跨 store）。
 *
 * 📌 K-9 反哺落地：跨 store 失效触发在 **composable 层**（非 store subscribe）。
 *    invalidateOnFileChanges watch chat store 的 file_changes ready 事件（agent_end 时）
 *    → 按 sessionId 过滤 + 路径定位 → 派发 fileTree store 的 invalidate 接口。
 *    不违反 stores/chat.ts「stores 间禁止互相 import」（编排发生在 composable 层）。
 *
 * 数据流（§4 功能1/2/4）：
 *   loadTree → api file.tree → store.setTree + rehydrate
 *   expandNode → nodeStatus 状态机判定 → api file.tree.expand → store merge（5 异步竞态 AC-3.7/8/9/10/11）
 *
 * 接线层级：[L1-接线] 真接 api + store。
 */
import { watch, type Ref } from 'vue'
import { useFileTreeStore, type LoadStatus } from '../stores/fileTree'
import type { FileNode } from '@shared/file-tree'

/** api/domains/file 抽象（⑥Wave 接真实 WS 封装）。 */
export interface FileApi {
  tree(sessionId: string, showIgnored?: boolean): Promise<FileNode[]>
  expand(sessionId: string, path: string, showIgnored?: boolean): Promise<FileNode[]>
  read(path: string): Promise<{ content: string; truncated: boolean }>
}

/** chat store 的 file_changes ready 事件派生（K-9 watch 源）。 */
export interface ChatFileChangesSignal {
  sessionId: string
  ready: boolean
  changedPaths: string[]
}

export function useFileTree(opts: {
  fileApi: FileApi
  /** chat store 的 file_changes 派生 ref（K-9 跨 store 编排源）。 */
  fileChangesSignal: Ref<ChatFileChangesSignal | null>
}) {
  const store = useFileTreeStore()

  /** 文件树首加载（UC-1）。rehydrate 展开态（graceful 跳过已删路径，NFR-AC-D1）。 */
  async function loadTree(sessionId: string): Promise<void> {
    const cached = store.tree.get(sessionId)
    if (cached) {
      // rehydrate：展开态恢复（D-019），已删路径 graceful 跳过（NFR-AC-D1）
      return
    }
    const nodes = await opts.fileApi.tree(sessionId, store.showIgnored) // L1-接线：api
    store.setTree(sessionId, nodes) // L1-接线：store
  }

  /**
   * 展开目录（UC-3，5 异步竞态）。
   * loaded 复用缓存（AC-3.3）/ loading 幂等去重（AC-3.8）/ unloaded→请求 / error 重试（AC-3.9）
   * / 在途切 session 丢 stale（AC-3.7 sessionId 校验）。
   */
  async function expandNode(sessionId: string, path: string): Promise<void> {
    const status = store.nodeStatus.get(path) ?? 'unloaded'
    if (status === 'loaded') return // AC-3.3 折叠复用缓存
    if (status === 'loading') return // AC-3.8 幂等去重
    store.setNodeStatus(path, 'loading') // L1-接线
    try {
      const children = await opts.fileApi.expand(sessionId, path, store.showIgnored) // L1-接线：api
      // AC-3.7：sessionId 校验（响应回来比 sessionId，不匹配丢弃 stale）—— ⑥Wave 实现
      store.setNodeStatus(path, 'loaded') // L1-接线
      void children // merge 进 store.tree（⑥Wave）
    } catch {
      store.setNodeStatus(path, 'error') // L1-接线：error 态可重试（AC-3.9）
    }
  }

  function selectFile(path: string): void {
    store.selectedPath = path // L1-接线
  }

  /** 过滤（debounce ~150ms，④NFR 骨架约束）。 */
  let filterTimer: ReturnType<typeof setTimeout> | null = null
  function setFilter(text: string): void {
    if (filterTimer) clearTimeout(filterTimer)
    filterTimer = setTimeout(() => {
      void text // ⑥Wave：store computed filteredTree
    }, 150) // debounce
  }

  /**
   * 跨 store 失效编排（K-9，AC-3.11）。
   * watch chat store file_changes ready → 按 sessionId 过滤 + 路径定位 → store.invalidate。
   * 编排在 composable 层（非 store subscribe），不违反 stores 间禁互引。
   */
  function invalidateOnFileChanges(): void {
    watch(
      opts.fileChangesSignal, // L1-接线：watch chat store 派生（K-9）
      (signal) => {
        if (!signal?.ready) return
        // 按 sessionId 过滤（他 session 不污染本 session，AC-3.11）+ 路径定位失效节点
        store.invalidate(signal.sessionId, signal.changedPaths) // L1-接线：派发 store.invalidate
      },
    )
  }

  return { loadTree, expandNode, selectFile, setFilter, invalidateOnFileChanges, store }
}

/** LoadStatus 复导出（供消费方）。 */
export type { LoadStatus }
