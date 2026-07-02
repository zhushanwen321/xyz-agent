/**
 * useFileChangeInvalidation —— 跨 store 失效编排的共享 helper（消除 D3 重复）。
 *
 * 背景：useFileTree.setupInvalidation 与 useFileSearch.setupInvalidation 曾近乎复制——
 * 都 watch [sessionIdRef, chatStore.messages]，提取 assistant 消息的 fileChanges paths，
 * diff lastPaths 快照，仅在 paths 集合增长时触发 store.invalidate。两者唯一差异是
 * invalidate 的语义（增量 changed paths vs 全量 sid）。此处抽出共同 watch + 提取 + diff
 * 逻辑，由调用方经 onInvalidate 回调各自表达失效语义。
 *
 * 多实例隔离：lastPaths 为每次调用闭包内的局部状态（原实现亦是闭包局部，非模块级缓存），
 * 故每个 setup 调用拥有独立的快照，多实例互不干扰。
 *
 * 依赖方向：本 helper 仅 watch chatStore（不直接 import 任何业务 store），调用方负责
 * 决定如何 invalidate 自己的 store——保持「stores 间禁止 import」约束。
 */
import { watch, type Ref } from 'vue'
import { useChatStore } from '@/stores/chat'

/**
 * 失效回调：当检测到 fileChanges paths 集合增长时触发。
 * @param sid        当前 session id（已确保非空）
 * @param newPaths   本次相比上次新增的 paths（即 diff 出的增量，非空）
 */
export type FileChangeInvalidateFn = (sid: string, newPaths: string[]) => void

/**
 * 监听 chat store 的 fileChanges 变化，提取最新 filePaths 并与上次快照 diff，
 * 仅当出现新 path 时回调 onInvalidate（避免每帧重复触发）。
 *
 * watch 触发条件、deep+immediate、session 切换重订阅、lastPaths 快照逻辑均与原
 * useFileTree / useFileSearch.setupInvalidation 逐一等价——纯重构，不改失效时机/范围。
 *
 * @param sessionIdRef session id 的 ref（变化时 watch 自动重订阅）
 * @param onInvalidate 失效回调，调用方在此表达自己的 invalidate 语义
 * @returns unwatch 函数（组件 onBeforeUnmount 调用，避免泄漏）
 */
export function watchFileChangesForInvalidation(
  sessionIdRef: Ref<string>,
  onInvalidate: FileChangeInvalidateFn,
): () => void {
  const chatStore = useChatStore()
  // 上次处理的 fileChanges paths 快照（去重：仅 paths 集合变化时才 invalidate）
  let lastPaths = new Set<string>()

  const unwatch = watch(
    [() => sessionIdRef.value, () => chatStore.messages],
    () => {
      const sid = sessionIdRef.value
      if (!sid) {
        // session 清空 → 重置快照（原实现行为：切走后下次切回从全量开始 diff）
        lastPaths = new Set()
        return
      }
      // 提取该 session 所有 assistant message 的 fileChanges paths
      const msgs = chatStore.getMessages(sid)
      const currentPaths = new Set<string>()
      for (const m of msgs) {
        if (m.role !== 'assistant') continue
        for (const fc of m.fileChanges ?? []) {
          currentPaths.add(fc.filePath)
        }
      }
      // 仅当出现新 path 时才 invalidate（相对上次快照的增量）
      const changed = [...currentPaths].filter((p) => !lastPaths.has(p))
      if (changed.length > 0) {
        onInvalidate(sid, changed)
      }
      lastPaths = currentPaths
    },
    { deep: true, immediate: true },
  )

  return unwatch
}
