/**
 * useGitStatus —— cwd 的 git 状态数据层（panel/spec.md git 进抽屉后唯一数据源）。
 *
 * 架构定位：原 GitZone.vue（底部 zone ⑤）内联的数据逻辑下沉为此 composable。
 * git 全量状态 UI 现位于 SideDrawer git tab（GitPanel.vue），PanelHeader 右侧
 * git 图标按钮承载入口 + 脏状态点。两处需共享同一份数据（抽屉内 stage 后 header
 * 点须同步更新），故由 Panel.vue 持有唯一实例，经 provide/inject（GIT_STATUS_KEY）
 * 共享给 GitPanel——避免双实例的 stale 隐患（stage/unstage 仅刷新自己实例）。
 *
 * 数据源：api git.status（real 走 transport，mock 走 fixture）。刷新时机（G-R2-04）：
 * 进入 session + agent_end 后 + stage/unstage/commit 操作后手动刷（非轮询）。
 * 非 git 仓库（isRepo=false）→ result.isRepo=false，调用方据此自隐藏。
 *
 * 四态派生（优先级 conflict > dirty > staged > clean）与原 GitZone 一致。
 *
 * 依赖方向：仅依赖 shared 类型 + api(git/events)。与 useChat/useSidebar 同属 features 层，
 * 但比它们轻——不触碰 stores，纯 per-session 数据 ref。
 */
import { ref, computed, watch, inject, provide, onScopeDispose, type InjectionKey, type Ref, type ComputedRef } from 'vue'
import { git as gitApi } from '@/api'
import { on as onSessionEvent } from '@/api/events'
import type { ServerMessage, GitStatusResult } from '@xyz-agent/shared'

/** git 四态（优先级 conflict > dirty > staged > clean） */
export type GitState = 'conflict' | 'dirty' | 'staged' | 'clean'

/** header 脏状态点所需的精简指示（hasRepo=false 时整块不渲染） */
export interface GitIndicator {
  hasRepo: boolean
  hasChanges: boolean
  dirty: boolean
  conflict: boolean
}

/** useGitStatus 返回形状 —— 供 InjectionKey 类型锁定 */
export interface UseGitStatusReturn {
  result: Ref<GitStatusResult | null>
  state: ComputedRef<GitState>
  indicator: ComputedRef<GitIndicator>
  pending: Ref<boolean>
  error: Ref<string>
  commitMsg: Ref<string>
  canCommit: ComputedRef<boolean>
  refresh: () => Promise<void>
  stageAll: () => Promise<void>
  unstageAll: () => Promise<void>
  commit: () => Promise<void>
}

/** provide/inject key：PanelContainer 持有唯一实例（跟随 active panel 的 session）→ GitPanel 注入 */
export const GIT_STATUS_KEY: InjectionKey<UseGitStatusReturn> = Symbol('git-status')

/**
 * @param sessionIdRef session 标识（ref 或 getter），变化时重置并重订阅 message.complete
 */
export function useGitStatus(sessionIdRef: Ref<string | null> | (() => string | null)): UseGitStatusReturn {
  const getSessionId = typeof sessionIdRef === 'function' ? sessionIdRef : () => sessionIdRef.value

  const result = ref<GitStatusResult | null>(null)
  const pending = ref(false)
  const error = ref('')
  const commitMsg = ref('')

  /** 四态派生（优先级 conflict > dirty > staged > clean） */
  const state = computed<GitState>(() => {
    if (!result.value) return 'clean'
    if (result.value.hasConflict) return 'conflict'
    if (result.value.unstagedCount > 0) return 'dirty'
    if (result.value.stagedCount > 0) return 'staged'
    return 'clean'
  })

  /** header 脏状态点指示（hasRepo=false → 整块不渲染；clean → 无点） */
  const indicator = computed<GitIndicator>(() => {
    const r = result.value
    if (!r || !r.isRepo) return { hasRepo: false, hasChanges: false, dirty: false, conflict: false }
    return {
      hasRepo: true,
      hasChanges: r.stagedCount > 0 || r.unstagedCount > 0,
      dirty: r.unstagedCount > 0,
      conflict: r.hasConflict,
    }
  })

  /** 可提交：非冲突 + 非空 message + 非 pending（runtime 要求非空 message） */
  const canCommit = computed(
    () => !pending.value && !result.value?.hasConflict && commitMsg.value.trim().length > 0,
  )

  async function refresh(): Promise<void> {
    const sid = getSessionId()
    if (!sid || pending.value) return
    pending.value = true
    error.value = ''
    try {
      result.value = await gitApi.status(sid)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      pending.value = false
    }
  }

  /** 统一操作包装：pending guard + 错误回显 + 成功后刷新 status */
  async function runOp(fn: () => Promise<void>): Promise<void> {
    const sid = getSessionId()
    if (!sid || pending.value) return
    pending.value = true
    error.value = ''
    try {
      await fn()
      result.value = await gitApi.status(sid)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      pending.value = false
    }
  }

  async function stageAll(): Promise<void> {
    const sid = getSessionId()
    if (!sid) return
    await runOp(() => gitApi.stage(sid))
  }

  async function unstageAll(): Promise<void> {
    const sid = getSessionId()
    if (!sid) return
    await runOp(() => gitApi.unstage(sid))
  }

  async function commit(): Promise<void> {
    if (!canCommit.value) return
    const sid = getSessionId()
    if (!sid) return
    const msg = commitMsg.value.trim()
    await runOp(async () => {
      await gitApi.commit(sid, msg)
      commitMsg.value = ''
    })
  }

  // 切换 session 时重置并刷新
  watch(
    getSessionId,
    () => {
      result.value = null
      commitMsg.value = ''
      error.value = ''
      refresh()
    },
    { immediate: true },
  )

  // agent_end 后刷新（G-R2-04/C14）：agent 改动文件后 git 状态变 stale，回合结束时重拉。
  // 订阅会话级 message.complete（agent 回合结束），随 sessionId 变化重建订阅，避免轮询/filesystem watch。
  let unsubComplete: (() => void) | null = null
  watch(
    getSessionId,
    (sid) => {
      unsubComplete?.()
      unsubComplete = sid
        ? onSessionEvent(sid, (msg: ServerMessage) => {
          if (msg.type === 'message.complete') refresh()
        })
        : null
    },
    { immediate: true },
  )
  onScopeDispose(() => unsubComplete?.())

  return {
    result,
    state,
    indicator,
    pending,
    error,
    commitMsg,
    canCommit,
    refresh,
    stageAll,
    unstageAll,
    commit,
  }
}

/** 便捷封装：在 PanelContainer 提供 git 状态实例（唯一数据源，跟随 active panel 的 session） */
export function provideGitStatus(sessionIdRef: Ref<string | null> | (() => string | null)): UseGitStatusReturn {
  const git = useGitStatus(sessionIdRef)
  provide(GIT_STATUS_KEY, git)
  return git
}

/** GitPanel 注入 git 状态（必填，缺失即调用方装配错误） */
export function useGitStatusOrFail(): UseGitStatusReturn {
  const git = inject(GIT_STATUS_KEY, null)
  if (!git) {
    throw new Error('useGitStatusOrFail: GIT_STATUS_KEY 未注入——GitPanel 必须挂在 PanelContainer 之下')
  }
  return git
}
