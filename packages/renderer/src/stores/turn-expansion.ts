/**
 * TurnExpansion store —— per-session 的「消息 turn 展开/折叠」状态容器（w4 store 重构）。
 *
 * 背景：w1 阶段 useTurnExpansion 基于 useSessionScopedState（per-instance Map）。
 * w4 接线时 Turn.vue 与 MessageStream.vue 各调一次 useTurnExpansion，两个实例各自维护
 * 一份 Map 分区，导致同一 session 下两处展开态不共享（rail 展开一个 turn，Turn 内
 * 的 trace 不跟着展开）。改为 Pinia store 后，store 单例（每 Pinia 实例）全局共享，
 * 所有调用方读写同一份 state，per-session 隔离由 store 内 sessionId 分区天然保证。
 *
 * 响应式策略：外层 plain Map + 内层 reactive Map（混合范式，原因见 getPartition 注释）。
 * - 外层 partitions（plain Map）：sessionId → 内层 reactive Map<turnIdx, boolean>，非响应式
 * - 内层分区（reactive Map）：turnIdx → expanded
 * Vue 3 reactive 对 Map 的 get/set/delete 均建立响应式追踪，故在 effect/computed 内
 * 读 `partition.get(idx)` 后，对同一 idx 的 set（expand/collapse/toggle）会让依赖失效重跑
 * （TC-w1-7 / TC-w1-9 契约：一次 mutate 一次重跑）。collapse 用赋值 false 而非 delete
 * （保 idx 响应式链不断）。
 *
 * session 销毁：clearSession 注册到 useSessionScopedState 的模块级 cleanup registry，
 * triggerSessionCleanups(sid) 时各 store 各清自己的分区，防 Map 积累已销毁 session 条目。
 *
 * 依赖方向：仅依赖 registerSessionCleanup（composables/useSessionScopedState 导出的
 * 模块级 registry），不依赖其他 store（stores 间禁止互相 import）。
 */
import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { registerSessionCleanup } from '@/composables/useSessionScopedState'

/** 单个 session 的展开状态：turnIdx → 是否展开（DM1） */
export type TurnExpansionPartition = Map<number, boolean>

export const useTurnExpansionStore = defineStore('turn-expansion', () => {
  // 外层 plain Map（非响应式）：sessionId → 内层 reactive Map<turnIdx, boolean>。
  // 关键：外层故意非响应式。分区在「读 isExpanded 时惰性创建」（见 getPartition 的注释），
  // 这样 expand(idx) 第一次调用时 partition 已存在（effect 首跑读 isExpanded 已创建），
  // expand 只 mutate 内层 reactive Map 的 idx → 单次 effect 失效重跑（TC-w1-7/w1-9 契约：
  // 一次 expand 对应一次 effect 重跑，不双触发）。若外层也 reactive，expand 第一次调用
  // 会同时触发「外层 Map 新增 key」+「内层 idx set」两个响应式通知，effect 重跑两次。
  const partitions = new Map<string, TurnExpansionPartition>()

  /**
   * 取或创建 session 分区。新分区用 reactive(new Map()) 包裹，使内层 idx 的 get/set
   * 被追踪（effect 读 partition.get(idx) 后，partition.set(idx, ...) 触发失效重跑）。
   *
   * 惰性创建契约：isExpanded(sid, idx) 读时若分区不存在会先创建空分区（与 w1
   * useSessionScopedState 的 current computed 惰性 init 一致）。这保证 expand/collapse
   * 调用前 effect 首跑（读 isExpanded）已建立对 idx 的依赖，写时单次失效重跑。
   */
  function getPartition(sid: string): TurnExpansionPartition {
    let p = partitions.get(sid)
    if (!p) {
      p = reactive(new Map<number, boolean>())
      partitions.set(sid, p)
    }
    return p
  }

  /**
   * 查询指定 turn 是否展开。key 不存在默认 false。在 effect 内读会建立对 idx 的依赖。
   * 走 getPartition（惰性创建分区）：保证 effect 首跑后 partition 已存在，
   * 后续 expand/collapse 对同 idx 的 set 才能精确触发该依赖失效（不双触发）。
   */
  function isExpanded(sid: string, idx: number): boolean {
    return getPartition(sid).get(idx) === true
  }

  /** 翻转展开态 */
  function toggle(sid: string, idx: number): void {
    const p = getPartition(sid)
    p.set(idx, !p.get(idx))
  }

  /** 设为展开 */
  function expand(sid: string, idx: number): void {
    getPartition(sid).set(idx, true)
  }

  /**
   * 设为折叠。用赋值 false 而非 delete：保 idx 的响应式链不断，
   * 已订阅 isExpanded(sid, idx) 的下游在 false↔true 来回切时仍正确重算。
   */
  function collapse(sid: string, idx: number): void {
    getPartition(sid).set(idx, false)
  }

  /** 批量展开 */
  function expandAll(sid: string, idxs: number[]): void {
    const p = getPartition(sid)
    for (const i of idxs) {
      p.set(i, true)
    }
  }

  /** 批量折叠 */
  function collapseAll(sid: string, idxs: number[]): void {
    const p = getPartition(sid)
    for (const i of idxs) {
      p.set(i, false)
    }
  }

  /** 任一 turn 处于展开态 */
  function hasAnyExpanded(sid: string, idxs: number[]): boolean {
    if (idxs.length === 0) return false
    const p = getPartition(sid)
    return idxs.some((i) => p.get(i) === true)
  }

  /** session 销毁时清分区（注册到模块级 cleanup registry，由 triggerSessionCleanups 编排） */
  function clearSession(sid: string): void {
    partitions.delete(sid)
  }

  // 注册到模块级 cleanup registry（session 销毁编排，与 useSessionScopedState 实例同列）。
  // 不反注册：store 与 Pinia app 同生命周期，模块级 registry 在 app 卸载前一直有效。
  registerSessionCleanup(clearSession)

  return {
    partitions,
    isExpanded,
    toggle,
    expand,
    collapse,
    expandAll,
    collapseAll,
    hasAnyExpanded,
    clearSession,
  }
})
