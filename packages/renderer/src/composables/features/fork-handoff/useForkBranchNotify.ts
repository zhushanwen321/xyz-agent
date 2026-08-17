/**
 * useForkBranchNotify —— 后台分支通知编排（FR-19，spec §4 Key States + §8.5）。
 *
 * 职责：追踪后台分支 session 的状态变化（running→done/error/waiting），把变化路由到
 * 主线反馈行（ForkNotice 追加通知）+ 侧栏未读角标。transient 映射（运行期内存，不持久化）。
 *
 * 数据流：
 * - 数据源：config.sessions 全量广播（含 status/outcome），diff 对比分支 session 的 status 变化
 * - 触发条件：分支 session 从 running（status 'active'）变为 done/error/stopped/waiting（终态/需关注）
 * - 路由目标：onBranchStatusChange 回调（调用方接线 → 反馈行追加 + 角标）
 *
 * 生命周期：composable 实例级订阅（watch + onScopeDispose 退订），不依赖任何 store，
 * 保持纯编排（调用方注入回调决定如何展示，遵循 R2 features 层 composable 范式）。
 *
 * W4 阶段：本 composable 提供完整状态追踪骨架（diff + 路由），UI 接线（反馈行追加、
 * 角标渲染）在集成阶段由调用方挂接 onBranchStatusChange 实现。
 */
import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import type { SessionGroup, SessionStatus } from '@xyz-agent/shared'

/** 分支状态变化的语义分类（spec §4 Key States） */
export type BranchChangeKind = 'done' | 'error' | 'waiting' | 'stopped'

/** 分支状态变化事件（路由给调用方 → 反馈行追加 + 角标） */
export interface BranchStatusChange {
  /** 分支 session id（路由 key） */
  branchId: string
  /** 源 session id（父 session，反馈行落点） */
  srcSessionId: string
  /** 变化语义（done/error/waiting/stopped） */
  kind: BranchChangeKind
  /** 分支 label（反馈行文案用） */
  label: string
}

/** 后台分支追踪记录（transient，运行期内存） */
interface BranchTrack {
  /** 上次观测到的 status（diff 基线） */
  lastStatus: SessionStatus
  /** 源 session id（反馈行落点路由） */
  srcSessionId: string
  /** 分支 label */
  label: string
}

/** running 态（status 'active' = pi 进程存活且生成中，可被观测状态翻转） */
const RUNNING_STATUS: SessionStatus = 'active'

/**
 * status → BranchChangeKind 映射（仅 running→终态/需关注 触发通知）。
 * idle→其他不触发（idle 是默认态，非「后台跑完」语义）。
 */
function classifyChange(from: SessionStatus, to: SessionStatus): BranchChangeKind | null {
  // 仅 running 起源的翻转才通知（后台分支「跑完/出错/需关注」心智）
  if (from !== RUNNING_STATUS) return null
  switch (to) {
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'stopped':
      return 'stopped'
    // waiting（等审批/工具阻塞）在 SessionStatus 无独立值，由前端 DerivedStatus 派生；
    // 此处保留扩展点，集成时若 runtime 提供 waiting 信号可在此分支路由。
    default:
      return null
  }
}

/**
 * 后台分支通知编排 composable。
 *
 * @param groupsRef 当前 SessionGroup[] 的 ref（来自 useSidebar 监听 config.sessions 后的 setGroups）。
 *   每次 groups 变化触发 diff——遍历所有 session，对 parentSession 有值（即分支）的项做状态对比。
 * @returns
 *   - trackedBranches：当前追踪的分支 id 集合（响应式，供 UI 展示角标等）
 *   - unreadByBranch：分支 id → 未读标记（响应式，需关注/已完成未查看时为 true）
 *   - registerFork(srcSessionId, branchId, label)：fork 成功时注册新分支（建立追踪基线）
 *   - clearUnread(branchId)：用户查看分支后清未读角标
 *
 * 调用方接线方式（集成阶段）：
 * ```ts
 * const { trackedBranches, registerFork, clearUnread } = useForkBranchNotify(groupsRef)
 * events.onGlobalType('session.forkNotice', (msg) => {
 *   registerFork(msg.srcSessionId, msg.newSessionId, msg.preview || msg.branchName || '')
 * })
 * ```
 *
 * 状态变化通知的 UI 接线（反馈行追加）：调用方可在 groupsRef watch 之外，
 * 自行 watch trackedBranches 或通过本 composable 暴露的 onChange 回调接线（W4 预留）。
 */
export function useForkBranchNotify(groupsRef: Ref<SessionGroup[]>): {
  /** 追踪中的分支 id 集合（响应式 Set） */
  trackedBranches: Ref<ReadonlySet<string>>
  /** 分支 id → 未读标记（需关注/已完成未查看） */
  unreadByBranch: Ref<ReadonlyMap<string, boolean>>
  /** 注册新 fork 分支（建立追踪基线，fork 广播后调用） */
  registerFork: (srcSessionId: string, branchId: string, label: string) => void
  /** 清除某分支未读角标（用户查看后调） */
  clearUnread: (branchId: string) => void
  /** 状态变化回调注册（调用方接线反馈行追加；返回取消函数） */
  onBranchStatusChange: (cb: (change: BranchStatusChange) => void) => () => void
} {
  /** 追踪表：branchId → BranchTrack（shallowRef + Map 重赋值触发响应式） */
  const trackMap = shallowRef(new Map<string, BranchTrack>())
  /** 未读标记：branchId → boolean（Map 重赋值触发响应式） */
  const unreadMap = shallowRef(new Map<string, boolean>())
  /** 状态变化回调集合（多调用方可注册） */
  const changeCbs = new Set<(change: BranchStatusChange) => void>()

  /**
   * diff groups：遍历所有 session，对 parentSession 有值（分支）的项做 status 对比。
   * 仅追踪中的分支触发变化检测（未注册的分支无 srcSessionId 落点，不通知）。
   */
  function diffGroups(groups: SessionGroup[]): void {
    const next = new Map(trackMap.value)
    let changed = false
    for (const g of groups) {
      for (const s of g.sessions) {
        if (!s.parentSession) continue
        const tracked = next.get(s.id)
        if (!tracked) continue // 未注册（非本 composable 追踪的分支），跳过
        if (s.status === tracked.lastStatus) {
          // label 可能更新（重命名），同步但不触发通知
          if (s.label !== tracked.label) {
            tracked.label = s.label
            changed = true
          }
          continue
        }
        const kind = classifyChange(tracked.lastStatus, s.status)
        // 更新基线
        tracked.lastStatus = s.status
        tracked.label = s.label
        changed = true
        if (kind) {
          // 触发未读角标（done/error/waiting 均需用户关注）
          unreadMap.value = new Map(unreadMap.value).set(s.id, true)
          // 派发变化事件给调用方（反馈行追加）
          const change: BranchStatusChange = {
            branchId: s.id,
            srcSessionId: tracked.srcSessionId,
            kind,
            label: tracked.label,
          }
          for (const cb of changeCbs) cb(change)
        }
      }
    }
    if (changed) trackMap.value = next
  }

  // groups 变化触发 diff（diff 仅对比已注册分支，无注册时为空操作，安全）
  watch(groupsRef, (groups) => diffGroups(groups), { deep: true })

  /** 注册新 fork 分支：建立追踪基线（初始 status 来自下一次 groups 广播） */
  function registerFork(srcSessionId: string, branchId: string, label: string): void {
    const next = new Map(trackMap.value)
    // 初始 lastStatus 设为 running（fork 时分支刚创建必为 active）；
    // 下次 groups 广播若仍 active 则无变化，若已终态则触发通知。
    next.set(branchId, { lastStatus: RUNNING_STATUS, srcSessionId, label })
    trackMap.value = next
  }

  /** 清除某分支未读角标（用户 select 跳转查看后调） */
  function clearUnread(branchId: string): void {
    if (!unreadMap.value.has(branchId)) return
    const next = new Map(unreadMap.value)
    next.delete(branchId)
    unreadMap.value = next
  }

  /** 注册状态变化回调（返回取消函数） */
  function onBranchStatusChange(cb: (change: BranchStatusChange) => void): () => void {
    changeCbs.add(cb)
    return () => {
      changeCbs.delete(cb)
    }
  }

  // trackedBranches / unreadByBranch 作为只读响应式视图（派生自 Map keys）
  const trackedBranches = ref<ReadonlySet<string>>(new Set())
  watch(trackMap, (m) => {
    trackedBranches.value = new Set(m.keys())
  }, { immediate: true })

  // 退订：composable 作用域销毁时清理（避免泄漏 + 测试隔离）
  // 当前未直接订阅 events（diff 由 groupsRef watch 驱动），预留 onScopeDispose
  // 以便集成阶段若在此 composable 内订阅 session.forkNotice 时统一退订。
  onScopeDispose(() => {
    changeCbs.clear()
    trackMap.value = new Map()
    unreadMap.value = new Map()
  })

  return {
    trackedBranches,
    unreadByBranch: unreadMap,
    registerFork,
    clearUnread,
    onBranchStatusChange,
  }
}
