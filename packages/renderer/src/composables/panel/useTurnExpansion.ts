/**
 * useTurnExpansion —— 「消息 turn 展开/折叠」状态的薄包装（w4 store 重构 IF1）。
 *
 * 职责：保持 IF1 公开 API（w1 既定签名）不变，内部委托 turn-expansion store。
 *
 * 为什么改薄包装：w1 阶段基于 useSessionScopedState（per-instance Map），w4 接线发现
 * Turn.vue 与 MessageStream.vue 各调一次本 composable，两个实例各自维护一份 Map 分区，
 * 同一 session 下展开态不共享（rail 展开 turn，Turn 内 trace 不跟）。改用 Pinia store
 * 单例后，所有调用方共享同一份 state，per-session 隔离由 store 内 sessionId 分区保证。
 *
 * 响应式契约：store 内用双层 reactive Map（见 stores/turn-expansion.ts），下游 effect/computed
 * 在 isExpanded(idx) 读取时建立对 `partition.get(idx)` 的依赖，expand/collapse mutate 时
 * 依赖失效重算（TC-w1-7 / TC-w1-9 契约保持）。
 *
 * null sid 语义：所有写方法 no-op（不污染空串分区），isExpanded/hasAnyExpanded 返回 false。
 * 与 w1 的 null sid no-op 契约一致。
 */
import type { Ref } from 'vue'
import { useTurnExpansionStore } from '@/stores/turn-expansion'

export function useTurnExpansion(sessionId: Ref<string | null>): {
  isExpanded: (turnIndex: number) => boolean
  toggle: (turnIndex: number) => void
  expand: (turnIndex: number) => void
  collapse: (turnIndex: number) => void
  expandAll: (turnIndices: number[]) => void
  collapseAll: (turnIndices: number[]) => void
  hasAnyExpanded: (turnIndices: number[]) => boolean
} {
  const store = useTurnExpansionStore()

  /** 取当前 sid（null → 空串，store 操作空串分区无害但写方法仍按 null 语义 no-op） */
  function sid(): string | null {
    return sessionId.value
  }

  return {
    /** 查询指定 turn 是否展开。null sid 返回 false（与 w1 契约一致）。 */
    isExpanded: (turnIndex: number): boolean => {
      const s = sid()
      return s !== null && store.isExpanded(s, turnIndex)
    },
    /** 翻转展开态。null sid 时 no-op */
    toggle: (turnIndex: number): void => {
      const s = sid()
      if (s !== null) store.toggle(s, turnIndex)
    },
    /** 设为展开。null sid 时 no-op */
    expand: (turnIndex: number): void => {
      const s = sid()
      if (s !== null) store.expand(s, turnIndex)
    },
    /** 设为折叠。null sid 时 no-op */
    collapse: (turnIndex: number): void => {
      const s = sid()
      if (s !== null) store.collapse(s, turnIndex)
    },
    /** 批量展开。null sid 时 no-op */
    expandAll: (turnIndices: number[]): void => {
      const s = sid()
      if (s !== null) store.expandAll(s, turnIndices)
    },
    /** 批量折叠。null sid 时 no-op */
    collapseAll: (turnIndices: number[]): void => {
      const s = sid()
      if (s !== null) store.collapseAll(s, turnIndices)
    },
    /** 任一 turn 处于展开态。null sid 返回 false */
    hasAnyExpanded: (turnIndices: number[]): boolean => {
      const s = sid()
      return s !== null && store.hasAnyExpanded(s, turnIndices)
    },
  }
}
