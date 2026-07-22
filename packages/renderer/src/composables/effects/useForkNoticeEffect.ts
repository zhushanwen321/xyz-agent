/**
 * useForkNoticeEffect —— fork 反馈行 transient feed + 后台分支通知编排（FR-12/19，RV1+RV2）。
 *
 * 职责：
 * 1. 订阅 session.forkNotice 全局广播（runtime fork 成功后推送），按 srcSessionId 路由到
 *    对应 session 的对话流，插入 transient ForkNotice 反馈行（RV1）。
 * 2. 实例化 useForkBranchNotify 追踪后台分支状态变化（running→done/error/stopped），
 *    fork 成功时 registerFork 建立追踪基线；状态变化时 onBranchStatusChange 追加反馈行（RV2）。
 *
 * 数据流：
 * - session.forkNotice（global 广播，payload 含 srcSessionId/newSessionId/branchName/preview）
 *   → pushNotice(srcSessionId, { newSessionId, branchName, preview }) 入 feed
 *   → registerFork(srcSessionId, newSessionId, branchName ?? preview ?? '') 建立分支追踪基线
 * - config.sessions 广播更新 session.groups → useForkBranchNotify diff 检测分支 status 翻转
 *   → onBranchStatusChange(kind) → pushNotice(srcSessionId, { kind, branchName }) 追加状态行
 *
 * Transient 语义：feed 仅前端内存维护，不写 chat store messages（不持久化、不进 JSONL）。
 * session 删除时 clearSession 清 feed，避免悬挂。模块级单例 ref 让所有 MessageStream 实例
 * 共享同一份 feed（同 useForkModeChannel 模式），无需 store 或 provide/inject。
 *
 * 生命周期：App.vue onMounted 调 bindForkNoticeEffect() 注册全局订阅（onScopeDispose 退订）；
 * MessageStream 各实例调 useForkNoticeFeed() 读自身 session 的通知渲染。
 */
import { onScopeDispose, readonly, ref, shallowRef, watch, type DeepReadonly, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { ServerMessage, SessionGroup } from '@xyz-agent/shared'
import * as events from '@/api/events'
import { useSessionStore } from '@/stores/session'
import { useForkBranchNotify, type BranchChangeKind, type BranchStatusChange } from '@/composables/features/useForkBranchNotify'

/** ForkNotice 反馈行 entry（transient，前端内存） */
export interface ForkNoticeEntry {
  /** 唯一 id（dismiss/渲染 key 用），递增避免重复 */
  id: number
  /** 新分支 session id（查看跳转目标 + 状态变化对应用） */
  newSessionId: string
  /** 分支名（纯后台 fork）或提问预览（fork-ask）；状态行用分支 label */
  branchName?: string
  /** fork-ask 的提问预览（优先于 branchName 展示） */
  preview?: string
  /** 状态变化语义（done/error/stopped/waiting）：有值时反馈行展示分支跑完/出错的衍生文案 */
  kind?: BranchChangeKind
  /** 源分支是否已删除——true 时「查看」降级为纯文本（spec §4） */
  sessionDeleted?: boolean
}

/** 模块级自增 id（跨 session 全局唯一，dismiss/渲染 key 用） */
let noticeSeq = 0
/** 模块级 transient feed：srcSessionId → entries（shallowRef + Map 重赋值触发响应式） */
const feedMap = shallowRef<Map<string, ForkNoticeEntry[]>>(new Map())
/** 模块级分支追踪：trackedBranches / unreadByBranch（由 bindForkNoticeEffect 写入，侧栏角标读） */
const trackedBranchesRef = ref<ReadonlySet<string>>(new Set())
const unreadByBranchRef = ref<ReadonlyMap<string, boolean>>(new Map())

/**
 * 读取指定 session 的 ForkNotice 反馈行列表（响应式）。
 * MessageStream 各实例调此函数读自身 session 的通知，在对话流末尾渲染。
 */
export function useForkNoticeFeed(): {
  /** entries（只读，派生自 feedMap，响应式） */
  notices: (sessionId: string) => DeepReadonly<ForkNoticeEntry[]>
  /** 移除单条通知（用户点关闭 ×） */
  dismissNotice: (sessionId: string, noticeId: number) => void
  /** 清空指定 session 全部通知（session 删除时调） */
  clearSession: (sessionId: string) => void
  /** feed 原始 ref（测试/调试用） */
  feedRef: Ref<Map<string, ForkNoticeEntry[]>>
  } {
  /** 按 sessionId 取 entries（shallowRef 下每次重算，feedMap 变化即响应） */
  function notices(sessionId: string): DeepReadonly<ForkNoticeEntry[]> {
    return readonly(feedMap.value.get(sessionId) ?? [])
  }

  /** 移除单条通知 */
  function dismissNotice(sessionId: string, noticeId: number): void {
    const list = feedMap.value.get(sessionId)
    if (!list) return
    const next = list.filter((e) => e.id !== noticeId)
    const map = new Map(feedMap.value)
    if (next.length === 0) {
      map.delete(sessionId)
    } else {
      map.set(sessionId, next)
    }
    feedMap.value = map
  }

  /** 清空指定 session 全部通知 */
  function clearSession(sessionId: string): void {
    if (!feedMap.value.has(sessionId)) return
    const map = new Map(feedMap.value)
    map.delete(sessionId)
    feedMap.value = map
  }

  return { notices, dismissNotice, clearSession, feedRef: feedMap }
}

/** 测试隔离：重置模块级 feed + 分支追踪状态（beforeEach 调，防跨用例泄漏） */
export function resetForkNoticeFeed(): void {
  noticeSeq = 0
  feedMap.value = new Map()
  trackedBranchesRef.value = new Set()
  unreadByBranchRef.value = new Map()
  clearUnreadImpl = null
}

/**
 * 向 feed 推一条 ForkNotice entry（内部 helper）。
 * 不直接 export——bindForkNoticeEffect 闭包内调用。
 */
function pushNotice(
  srcSessionId: string,
  data: Omit<ForkNoticeEntry, 'id'>,
): void {
  noticeSeq += 1
  const entry: ForkNoticeEntry = { id: noticeSeq, ...data }
  const prev = feedMap.value.get(srcSessionId) ?? []
  const map = new Map(feedMap.value)
  map.set(srcSessionId, [...prev, entry])
  feedMap.value = map
}

/**
 * 注册全局 fork-notice 效果（RV1+RV2 接线点）。
 *
 * 在 App.vue onMounted 调用一次（单实例）。内部：
 * - 订阅 session.forkNotice 全局广播 → pushNotice + registerFork
 * - 实例化 useForkBranchNotify(session.groups) 追踪分支状态
 * - onBranchStatusChange → pushNotice 追加状态行
 * - 把 trackedBranches/unreadByBranch 同步到模块级 ref（侧栏角标跨组件读）
 * - onScopeDispose 退订（App 卸载时清理）
 */
export function bindForkNoticeEffect(): void {
  const sessionStore = useSessionStore()
  // groupsRef 供 useForkBranchNotify diff——storeToRefs 取响应式 ref（store 属性访问会被解包）。
  const { groups } = storeToRefs(sessionStore)
  const groupsRef: Ref<SessionGroup[]> = groups
  const { trackedBranches, unreadByBranch, registerFork, clearUnread, onBranchStatusChange } =
    useForkBranchNotify(groupsRef)

  // RV1：订阅 session.forkNotice 全局广播（payload 无 sessionId，routeInbound 走 global 通道）。
  // 收到后按 srcSessionId 把 ForkNotice 插入对应 session 的对话流（transient feed）。
  const unsubForkNotice = events.onGlobalType('session.forkNotice', (msg) => {
    const payload = (msg as ServerMessage<'session.forkNotice'>).payload
    const { srcSessionId, newSessionId, branchName, preview } = payload
    pushNotice(srcSessionId, { newSessionId, branchName, preview })
    // RV2：fork 成功 → registerFork 建立分支追踪基线（label 用 branchName/preview 兜底）。
    registerFork(srcSessionId, newSessionId, branchName ?? preview ?? '')
  })

  // RV2：后台分支状态变化（running→done/error/stopped）→ 追加反馈行通知。
  // kind 语义映射到反馈行：done → 分支已完成、error → 分支出错、stopped → 分支已停止。
  onBranchStatusChange((change: BranchStatusChange) => {
    pushNotice(change.srcSessionId, {
      newSessionId: change.branchId,
      branchName: change.label,
      kind: change.kind,
    })
  })

  // 同步分支追踪状态到模块级 ref（侧栏角标跨组件读）。
  watch(trackedBranches, (s) => { trackedBranchesRef.value = s }, { immediate: true })
  watch(unreadByBranch, (m) => { unreadByBranchRef.value = m }, { immediate: true })
  // 暴露 clearUnread 给 useForkBranchBadges（模块级引用，侧栏角标消费时调）。
  clearUnreadImpl = clearUnread

  onScopeDispose(() => {
    unsubForkNotice()
    clearUnreadImpl = null
    trackedBranchesRef.value = new Set()
    unreadByBranchRef.value = new Map()
  })
}

/**
 * 读取分支追踪状态（侧栏角标消费，RV2）。
 * 模块级单例 ref——bindForkNoticeEffect 写入，任意组件读 trackedBranches/unreadByBranch。
 * clearUnread 透传到 useForkBranchNotify（用户查看分支后清未读角标）。
 */
export function useForkBranchBadges(): {
  /** 追踪中的分支 id 集合（响应式，供侧栏角标展示） */
  trackedBranches: Ref<ReadonlySet<string>>
  /** 分支 id → 未读标记（需关注/已完成未查看） */
  unreadByBranch: Ref<ReadonlyMap<string, boolean>>
  /** 清除某分支未读角标（用户查看后调） */
  clearUnread: (branchId: string) => void
  } {
  // clearUnread 委托：bindForkNoticeEffect 在 App 作用域持有 useForkBranchNotify 实例，
  // 此处的 clearUnread 需访问该实例。通过模块级 ref 存最新实例引用（bind 时写入）。
  const clear = (branchId: string): void => {
    clearUnreadImpl?.(branchId)
  }
  return {
    trackedBranches: trackedBranchesRef,
    unreadByBranch: unreadByBranchRef,
    clearUnread: clear,
  }
}

/** 模块级 clearUnread 实现引用（bindForkNoticeEffect 写入） */
let clearUnreadImpl: ((branchId: string) => void) | null = null
