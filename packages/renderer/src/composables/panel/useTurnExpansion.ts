/**
 * useTurnExpansion —— per-session 的「消息 turn 展开/折叠」状态（w1 wave IF1）。
 *
 * 职责：维护当前 session 下各 turn（按 turnIndex 索引）的展开布尔值，
 * 供 Panel 渲染「展开更多」按钮 / 折叠按钮组消费。
 *
 * 为什么基于 useSessionScopedState：per-session 隔离由 Map 分区派天然保证（切 session
 * 自动隔离、session 销毁 cleanup 重置、null sid no-op），无需手写 watch 清理——
 * 避开 ADR-0036 中标记为脆弱的「watch 清理派」范式（useExtensionUI bug 即该范式失效）。
 *
 * 响应式契约：内部状态用 `reactive({})` 容器（useSessionScopedState 的 init 工厂返回值），
 * 使下游 effect/computed 在 `isExpanded(idx)` 读取时建立对 `state[idx]` 的依赖，
 * expand/collapse mutate 时依赖失效重算（TC-w1-7）。collapse 用赋值 `false` 而非 `delete`，
 * 保 key 响应式链不断（delete + 重读存在 Vue reactive 边沿，赋值更稳）。
 */
import { reactive, type Ref } from 'vue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

/** 单个 session 的展开状态：turnIndex → 是否展开（DM1） */
export type TurnExpansionState = Record<number, boolean>

export function useTurnExpansion(sessionId: Ref<string | null>): {
  isExpanded: (turnIndex: number) => boolean
  toggle: (turnIndex: number) => void
  expand: (turnIndex: number) => void
  collapse: (turnIndex: number) => void
  expandAll: (turnIndices: number[]) => void
  collapseAll: (turnIndices: number[]) => void
  hasAnyExpanded: (turnIndices: number[]) => boolean
} {
  // init 工厂必须返回 reactive 容器：mutate（expand/collapse）才能触发下游依赖失效。
  // null sid 时 useSessionScopedState 不写入 Map，update 也 no-op，故无需特殊处理。
  const { current, update } = useSessionScopedState<TurnExpansionState>(
    sessionId,
    () => reactive({}),
  )

  /**
   * 查询指定 turn 是否展开。key 不存在默认 false。
   * 读 current.value[idx] 在 reactive 容器上建立对 idx 的响应式依赖（TC-w1-7）。
   */
  function isExpanded(turnIndex: number): boolean {
    return current.value[turnIndex] === true
  }

  /** 翻转展开态 */
  function toggle(turnIndex: number): void {
    update((state) => {
      state[turnIndex] = !state[turnIndex]
    })
  }

  /** 设为展开 */
  function expand(turnIndex: number): void {
    update((state) => {
      state[turnIndex] = true
    })
  }

  /**
   * 设为折叠。用赋值 false 而非 delete：保 idx 的响应式链不断，
   * 已订阅 isExpanded(idx) 的下游在 false↔true 来回切时仍正确重算。
   */
  function collapse(turnIndex: number): void {
    update((state) => {
      state[turnIndex] = false
    })
  }

  /** 批量展开 */
  function expandAll(turnIndices: number[]): void {
    update((state) => {
      for (const idx of turnIndices) {
        state[idx] = true
      }
    })
  }

  /** 批量折叠 */
  function collapseAll(turnIndices: number[]): void {
    update((state) => {
      for (const idx of turnIndices) {
        state[idx] = false
      }
    })
  }

  /** 任一 turn 处于展开态 */
  function hasAnyExpanded(turnIndices: number[]): boolean {
    return turnIndices.some((idx) => current.value[idx] === true)
  }

  return {
    isExpanded,
    toggle,
    expand,
    collapse,
    expandAll,
    collapseAll,
    hasAnyExpanded,
  }
}
