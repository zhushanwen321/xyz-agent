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
 * [R-16] watch source 读 per-sid 内层分区 ref（D-1 容器的内层 ShallowRef，非整 Map），
 * 无 deep：同 sid 数组替换触发 / 异 sid 替换不触发（失效收敛，触发面从全部 session
 * 收敛到当前 session；同 sid 消息数组依赖不可变替换语义）。session 切换重订阅、
 * lastPaths 快照逻辑与原 useFileTree / useFileSearch.setupInvalidation 等价。
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
    [
      () => sessionIdRef.value,
      // [R-16 / D-1 伴生] source 读 per-sid 内层分区 ref（非整 Map）：同 sid 消息数组替换
      // （commitMessages 的不可变新数组）触发本 watcher；异 sid 分区替换不触发（失效收敛）。
      // 原 `() => chatStore.messages` + deep:true 会 traverse 进所有 Map entry 读各分区
      // ShallowRef.value 建立依赖——任何 session 更新都过度触发（P5 探针实证）。
      // sid 增删（外层 Map 替换）仍触发，回调内 lastPaths diff 兜底（无新 path 时 no-op）。
      () => chatStore.messages.get(sessionIdRef.value)?.value,
    ],
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
    { immediate: true },
  )

  return unwatch
}
