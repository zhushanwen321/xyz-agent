/**
 * Composer 顶部「已附上下文」chip 行的状态派生（W4：从 ContextChipsBar 本地 ref 改 props/emit 后的状态桥）。
 *
 * 职责：把 ComposerInput 的 segments 派生成 ContextChipsBar 的 items，并处理 × 删除回调。
 * 提取到 composable 以满足 Composer.vue <script setup> 行数上限（300 行）。
 *
 * 数据流：
 * - segments（image 段）→ attachedItems（{id=segment.id, name, type:'image'}）→ ContextChipsBar :items
 * - ContextChipsBar @remove(id) → onRemoveContextChip → ComposerInput.removeImageChip(chipId) → refreshAttachedItems
 *
 * [HISTORICAL] chip id 曾用 path，但同一文件附两次时 path 重复导致 Vue :key 冲突（删除不可靠）。
 * C3 改用 segment.id（composer chip 的稳定唯一 uuid，crypto.randomUUID 生成）。
 *
 * segments 是 DOM 即时读取（非响应式），需在 input 变化 / chip 删除后主动调 refreshAttachedItems。
 */
import { ref, type Ref } from 'vue'
import type { Segment } from '@xyz-agent/shared'

/**
 * ComposerInput 实例最小契约（getSegments / removeImageChip 经 defineExpose 暴露）。
 * 用结构类型避免 import .vue 文件（循环依赖 + 类型推断复杂）。
 */
interface ComposerInputInstance {
  getSegments(): Segment[]
  removeImageChip(chipId: string): void
}

/**
 * @param inputRef ComposerInput 实例 ref（getSegments / removeImageChip 经 defineExpose 暴露）
 */
export function useComposerContextChips(inputRef: Ref<ComposerInputInstance | null>) {
  /** ContextChipsBar 数据源：从 segments 派生的 image chips */
  const attachedItems = ref<Array<{ id: string; name: string; type: 'image' }>>([])

  /** 从输入区 segments 刷新 image chips（input 变化 / chip 删除后调） */
  function refreshAttachedItems(): void {
    const segs = inputRef.value?.getSegments() ?? []
    attachedItems.value = segs
      .filter((s): s is { type: 'image'; id: string; path: string; name: string } => s.type === 'image')
      .map((s) => ({ id: s.id, name: s.name, type: 'image' as const }))
  }

  /** ContextChipsBar × 删除回调：用 chipId（segment.id）定位 DOM 中 image chip 移除并刷新 */
  function onRemoveContextChip(id: string): void {
    inputRef.value?.removeImageChip(id)
    refreshAttachedItems()
  }

  return { attachedItems, refreshAttachedItems, onRemoveContextChip }
}
