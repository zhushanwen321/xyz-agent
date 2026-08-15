/**
 * watchFileChangesForInvalidation 触发收敛单测（W11 R-16 / 07 文档 P5 探针落地）。
 *
 * 背景：D-1 后 messages 是 `Map<sid, ShallowRef<Message[]>>`（外层恒等稳定）。
 * 原 watch source（整 Map + deep:true）经 P5 探针实证：deep traverse 会进每个 Map
 * entry 读分区 ShallowRef.value 建立依赖——任何 session 更新都过度触发。R-16 迁移
 * source 到 per-sid 内层 ref 并去 deep 后锁定：
 * - 同 sid 数组替换（commitMessages 不可变新数组）→ watcher 触发（不丢回调）
 * - 异 sid 分区替换 → 不触发（失效收敛到当前 session）
 * - 挂载时 sid 尚无分区 → 首条消息建 key（外层 Map 替换）→ watcher 触发（首帧全量回调）
 * - fileChanges paths 增长才回调 onInvalidate（diff 语义不变）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useFileChangeInvalidation.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { watchFileChangesForInvalidation } from '@/composables/features/file-tree/useFileChangeInvalidation'
import type { FileChange, Message } from '@xyz-agent/shared'

/** 构造带 fileChanges 的 complete assistant 消息 */
function assistantWithChanges(id: string, paths: string[]): Message {
  const fileChanges: FileChange[] = paths.map((filePath) => ({ filePath, status: 'modified' }))
  return { id, role: 'assistant', content: id, status: 'complete', timestamp: 1, fileChanges }
}

describe('watchFileChangesForInvalidation（R-16：per-sid 内层 ref 触发收敛）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('同 sid 消息数组替换触发回调（fileChanges paths 增长时 onInvalidate 收到增量）', async () => {
    const chatStore = useChatStore()
    const sidRef = ref('s1')
    chatStore.setMessages('s1', [assistantWithChanges('a1', ['/a.ts'])])

    const onInvalidate = vi.fn()
    const unwatch = watchFileChangesForInvalidation(sidRef, onInvalidate)
    try {
      // immediate 首跑：lastPaths 初始为空 → 已有 paths 作为首帧全量回调（原 helper 既有语义）
      await nextTick()
      expect(onInvalidate).toHaveBeenCalledTimes(1)
      expect(onInvalidate).toHaveBeenCalledWith('s1', ['/a.ts'])

      // 同 sid commit：新数组（fileChanges 增长）→ 触发 + 增量回调
      chatStore.setMessages('s1', [assistantWithChanges('a1', ['/a.ts']), assistantWithChanges('a2', ['/b.ts'])])
      await nextTick()
      expect(onInvalidate).toHaveBeenCalledTimes(2)
      expect(onInvalidate).toHaveBeenLastCalledWith('s1', ['/b.ts'])

      // 同 sid commit：无新 path → 不回调（lastPaths 快照 diff）
      chatStore.setMessages('s1', [assistantWithChanges('a1', ['/a.ts']), assistantWithChanges('a2', ['/b.ts', '/a.ts'])])
      await nextTick()
      expect(onInvalidate).toHaveBeenCalledTimes(2)
    } finally {
      unwatch()
    }
  })

  it('异 sid 分区替换不触发本 watcher（deep 过度触发消除，失效收敛）', async () => {
    const chatStore = useChatStore()
    const sidRef = ref('s1')
    chatStore.setMessages('s1', [assistantWithChanges('a1', ['/a.ts'])])
    chatStore.setMessages('s2', [assistantWithChanges('b1', ['/x.ts'])])

    const onInvalidate = vi.fn()
    const unwatch = watchFileChangesForInvalidation(sidRef, onInvalidate)
    try {
      await nextTick()
      expect(onInvalidate).toHaveBeenCalledTimes(1) // immediate 首跑 s1 全量
      expect(onInvalidate).toHaveBeenCalledWith('s1', ['/a.ts'])

      // 异 sid（s2）commit：即便 fileChanges 增长也不触发 s1 的 watcher
      chatStore.setMessages('s2', [assistantWithChanges('b1', ['/x.ts']), assistantWithChanges('b2', ['/new.ts'])])
      await nextTick()
      expect(onInvalidate).toHaveBeenCalledTimes(1)

      // 同 sid 仍正常触发（证明 watcher 未被误杀）
      chatStore.setMessages('s1', [assistantWithChanges('a1', ['/a.ts', '/c.ts'])])
      await nextTick()
      expect(onInvalidate).toHaveBeenCalledTimes(2)
      expect(onInvalidate).toHaveBeenLastCalledWith('s1', ['/c.ts'])
    } finally {
      unwatch()
    }
  })

  it('session 切换（sidRef 变化）重订阅：切到新 sid 后对新 sid 的 paths 增量回调', async () => {
    const chatStore = useChatStore()
    const sidRef = ref('s1')
    chatStore.setMessages('s1', [assistantWithChanges('a1', ['/a.ts'])])
    chatStore.setMessages('s2', [assistantWithChanges('b1', ['/b.ts'])])

    const onInvalidate = vi.fn()
    const unwatch = watchFileChangesForInvalidation(sidRef, onInvalidate)
    try {
      await nextTick()
      expect(onInvalidate).toHaveBeenCalledTimes(1) // immediate 首跑 s1 全量

      // 切到 s2：watch source 变化 → diff s2 相对 lastPaths（s1 快照）的增量
      sidRef.value = 's2'
      await nextTick()
      expect(onInvalidate).toHaveBeenCalledTimes(2)
      expect(onInvalidate).toHaveBeenLastCalledWith('s2', ['/b.ts'])
    } finally {
      unwatch()
    }
  })

  it('watcher 挂载时 sid 尚无分区：首条消息建 key（外层 Map 替换）后 watcher 触发', async () => {
    // 回归防护（Map 首建 key 路径，P5 探针已实证行为正确）：R-16 迁移后 source getter 读
    // `messages.get(sid)?.value`——挂载时无分区返回 undefined（只依赖外层 Map 替换），
    // 首条消息 commitMessages 走「新 Map + set」建 key 替换外层 Map → getter 重算
    // （undefined → 数组）→ watcher 触发，已有 paths 作为首帧全量回调。
    const chatStore = useChatStore()
    const sidRef = ref('s-late')

    const onInvalidate = vi.fn()
    const unwatch = watchFileChangesForInvalidation(sidRef, onInvalidate)
    try {
      // immediate 首跑：无分区 → 空 paths → 无增量，不回调
      await nextTick()
      expect(onInvalidate).not.toHaveBeenCalled()

      // 首条消息 commit：外层 Map 替换（建 key）→ watcher 触发（首帧全量）
      chatStore.setMessages('s-late', [assistantWithChanges('a1', ['/a.ts'])])
      await nextTick()
      expect(onInvalidate).toHaveBeenCalledTimes(1)
      expect(onInvalidate).toHaveBeenCalledWith('s-late', ['/a.ts'])
    } finally {
      unwatch()
    }
  })
})
