/**
 * useNewTaskFlow —— 新建任务流程编排 composable（#3，§3.3，单实例 Q2=A）。
 *
 * 职责：NewTaskFlowState 状态机（8 态）+ overlay 嵌套互斥 + Esc 优先级 + cwd 调度。
 * 深模块（§5）：调用方只看 state（只读）+ 动作方法，状态机守卫/转换表内部封装。
 *
 * 依赖方向（§2 严格边界）：api/domains（session）+ lib/utils（resolveDefaultCwd）+ lib/ipc（pickDirectory）+ stores/session。
 * 不直接 import transport（经 api/domains）。
 *
 * 接线层级（§3.3）：动作方法体 = 状态转换 + 对依赖的真调用；链路末端错误反馈（toast/composer 子态）
 * 由调用方（useSidebar/Vue 错误边界）处理，不在 composable 内组装（AC-3.13 错误策略分层）。
 *
 * Wave 范围：本文件实现状态机主干 + startFlow/openDirPopover/openBranchPopover/selectWorkspace/
 * openDirDialog/openBranchModal/closeOverlay/cancelFlow/reenterFlow/completeFlow。selectBranch/
 * confirmDirtySwitch/submitCreateBranch 依赖 gitApi.checkout/createBranch（#6/#7 Wave 2/3 落地），
 * 本 Wave 只守状态转换 + TODO 桩，Wave 2/3 补全 api 调用。
 */
import { ref, computed, readonly } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'
import { session as sessionApi, git as gitApi } from '@/api'
import { resolveDefaultCwd } from '@/lib/utils'
import { pickDirectory } from '@/lib/ipc'
import { useSessionStore } from '@/stores/session'

/** NewTaskFlow 8 态枚举（②§5） */
export type NewTaskFlowState =
  | 'idle'
  | 'landing'
  | 'dir-popover'
  | 'branch-popover'
  | 'dir-dialog'
  | 'branch-modal'
  | 'completed'
  | 'cancelled'

/** 当前 session 的 git 派生（UC-7 chip 可见性 + openBranchPopover 守卫） */
export interface GitInfo {
  branch: string
  isRepo: boolean
}

/** overlay 态集合（overlay 互斥 / cancelFlow 判定用） */
const OVERLAY_STATES: ReadonlySet<NewTaskFlowState> = new Set([
  'dir-popover',
  'branch-popover',
  'dir-dialog',
  'branch-modal',
])

/**
 * 合法转换表（§4.6 守卫表落地）。未列出的 from→to 组合 = 非法 → 抛错回 idle（AC-3.1/3.11）。
 * 终态：仅 completed（实例销毁）。cancelled 可重入（reenterFlow → landing）。
 */
const ALLOWED: Record<NewTaskFlowState, NewTaskFlowState[]> = {
  idle: ['landing'],
  landing: ['dir-popover', 'branch-popover', 'completed', 'cancelled'],
  'dir-popover': ['landing', 'dir-dialog', 'cancelled'],
  'branch-popover': ['landing', 'branch-modal', 'cancelled'],
  'dir-dialog': ['landing', 'dir-popover', 'cancelled'],
  'branch-modal': ['landing', 'cancelled'],
  completed: [], // 终态，无出口（⌘N 再触发走 startFlow 内的销毁重建）
  cancelled: ['landing'], // reenterFlow 复活
}

// ── 模块级单实例状态（Q2=A 单实例：composable 模块单例）──
const state: Ref<NewTaskFlowState> = ref('idle')
/** 当前 flow 绑定的 session（id/cwd 经 computed 派生，selectWorkspace 比对 cwd 用，保持②Session.cwd 不变式） */
const currentSession: Ref<SessionSummary | null> = ref(null)
/** startFlow in-flight 标记（AC-1.5 幂等：双击并发只建 1 session） */
const createInFlight = ref(false)
/** submitCreateBranch in-flight 标记（AC-7.9 飞行中 disabled 防重复 + T6.6 composable 层守卫） */
const branchCreateInFlight = ref(false)

/**
 * 重置 NewTaskFlow 单实例状态回 idle（测试隔离 / 应用初始化用）。
 * 单实例（Q2=A）的状态跨 useNewTaskFlow() 调用共享，测试需在 beforeEach 重置避免串扰。
 */
export function resetNewTaskFlow(): void {
  state.value = 'idle'
  currentSession.value = null
  createInFlight.value = false
  branchCreateInFlight.value = false
}

export function useNewTaskFlow() {
  const session = useSessionStore()

  /** 当前 flow 绑定 session 的 id（landing 态常态非 null；首次启动延迟 create 时为 null） */
  const currentSessionId: ComputedRef<string | null> = computed(
    () => currentSession.value?.id ?? null,
  )
  /** 当前 flow 绑定 session 的 cwd（chip 回灌 / selectWorkspace 比对用） */
  const currentCwd: ComputedRef<string | null> = computed(
    () => currentSession.value?.cwd ?? null,
  )

  /**
   * gitInfo（UC-7 chip 可见性派生）：从当前活跃 session 的 gitBranch 派生。
   * null → 非 git 目录，branch chip 隐藏且 branch-popover/branch-modal 不可达（状态机守卫 AC-3.7）。
   */
  const gitInfo: ComputedRef<GitInfo | null> = computed(() => {
    const s = session.active
    if (!s?.gitBranch) return null
    return { branch: s.gitBranch, isRepo: true }
  })

  /**
   * 状态转换（带守卫）。非法转换 → 计数 + 回 idle + 抛错（Vue 错误边界兼底，AC-3.11）。
   * NFR④#3：此处为 logger debug 接线点（每次转换 log from→to）。
   */
  function transition(target: NewTaskFlowState): void {
    const from = state.value
    if (!ALLOWED[from].includes(target)) {
      state.value = 'idle'
      throw new Error(`NewTaskFlow 非法状态转换: ${from} → ${target}`)
    }
    state.value = target
  }

  /**
   * startFlow —— 触发新建（§4.1 主流程）。
   *
   * 数据流：触发点 → startFlow → resolveDefaultCwd(sessions) → sessionApi.create(cwd) → state=landing。
   * - completed 终态再触发 → 销毁重建 idle（AC-3.12），再走常态/首次启动分支
   * - in-flight 标记防重复（E1/AC-1.5）：create 飞行中再触发 → 忽略
   * - cwd=undefined（首次启动，AC-1.7 延迟 create）→ 不调 create，currentSession=null，chip 空态+发送 disabled
   * - cwd 合法（常态）→ create(cwd) 绑定 session，进 landing；create reject（E2/E3）→ 状态留 idle，错误向上抛
   */
  async function startFlow(): Promise<void> {
    // 终态重建（AC-3.12）：completed 后 ⌘N 销毁重建
    if (state.value === 'completed') {
      state.value = 'idle'
      currentSession.value = null
    }
    if (createInFlight.value) return // E1 幂等保护（AC-1.5）
    const cwd = resolveDefaultCwd(session.list)
    // 首次启动：无可用 cwd → 延迟 create，仅进 landing 待选目录（AC-1.7）
    if (!cwd) {
      transition('landing') // idle→landing
      currentSession.value = null
      return
    }
    createInFlight.value = true
    try {
      // [内] 真接线 sessionApi.create（常态路径）；spawn 失败/非法 cwd 由 runtime reject → 向上抛（E2/E3）
      const created = await sessionApi.create(cwd)
      currentSession.value = created
      transition('landing') // idle→landing
    } finally {
      createInFlight.value = false
    }
  }

  /** landing→dir-popover（点 directory chip）。overlay 互斥：已开 branch-popover 时先归 landing 再开。 */
  function openDirPopover(): void {
    if (state.value === 'branch-popover') state.value = 'landing'
    transition('dir-popover')
  }

  /**
   * landing→branch-popover（点 branch chip）。
   * 守卫：gitInfo==null（非 git 目录）→ 抛错回 idle，popover 不可达（AC-3.7/UC-7）。
   * overlay 互斥：已开 dir-popover 时先归 landing 再开（AC-3.2 至多 1 个 overlay）。
   */
  function openBranchPopover(): void {
    if (gitInfo.value == null) {
      state.value = 'idle'
      throw new Error('NewTaskFlow: 非 git 目录不可打开分支选择')
    }
    if (state.value === 'dir-popover') state.value = 'landing'
    transition('branch-popover')
  }

  /**
   * selectWorkspace —— dir-popover 选已有 workspace（§4.2，Wave 2 #5 完整接入）。
   *
   * 不变式（保持②Session.cwd）：cwd 变了 → delete 空旧 session + create 新 session(newCwd)；
   * cwd 未变 → noop（仅关 popover）。dir-popover→landing。
   */
  async function selectWorkspace(cwd: string): Promise<void> {
    if (cwd === currentCwd.value) {
      transition('landing') // noop：仅关 popover
      return
    }
    if (currentSessionId.value) {
      await sessionApi.remove(currentSessionId.value)
    }
    const created = await sessionApi.create(cwd)
    currentSession.value = created
    transition('landing') // dir-popover→landing（chip 回灌新 cwd）
  }

  /**
   * openDirDialog —— 打开 OS 目录选择器（§4.2）。
   *
   * 数据流：dir-popover → ipc.pickDirectory → OS dialog →
   * 选中→delete+create(newCwd)+landing / 取消→落回 dir-popover（AC-5.3）。
   * E5 IPC 招错（getFocusedWindow null）→落回 dir-popover + 向上抛（调用方接 toast，AC-5.6），
   * 状态不卡在 dir-dialog（错误路径重置状态，CLAUDE.md #3）。
   */
  async function openDirDialog(): Promise<void> {
    transition('dir-dialog') // dir-popover→dir-dialog
    try {
      const result = await pickDirectory()
      if (result.canceled || !result.path) {
        transition('dir-popover') // 取消落回（AC-5.3）
        return
      }
      // 选中：与 selectWorkspace 同语义（delete 空旧 + create 新 cwd）
      if (currentSessionId.value && result.path !== currentCwd.value) {
        await sessionApi.remove(currentSessionId.value)
      }
      if (result.path !== currentCwd.value) {
        currentSession.value = await sessionApi.create(result.path)
      }
      transition('landing') // dir-dialog→landing（chip 回灌新 cwd）
    } catch (e) {
      // E5：IPC 招错 → 落回 dir-popover + 重抛（调用方显错 toast），不卡 dir-dialog
      transition('dir-popover')
      throw e
    }
  }

  /**
   * selectBranch —— 选干净分支直切（§4.3，#6）。
   * checkout reject（冲突/分支不存在）→ 向上抛，state 留 branch-popover 显错（AC-6.4）；成功→landing。
   */
  async function selectBranch(name: string): Promise<void> {
    if (!currentSessionId.value) throw new Error('NewTaskFlow: 无绑定 session，无法切换分支')
    await gitApi.checkout(currentSessionId.value, name) // reject 则留 branch-popover
    transition('landing') // branch-popover→landing
  }

  /**
   * confirmDirtySwitch —— dirty 分支二次确认后切走（§4.3，AC-6.2，#6）。
   * v1 选「留在工作区」：仅 git checkout（git 默认携带未提交改动），不 stash、不丢弃。
   * 与 selectBranch 同语义（确认动作在组件 inline 条，composable 只执行切走）。
   */
  async function confirmDirtySwitch(name: string): Promise<void> {
    if (!currentSessionId.value) throw new Error('NewTaskFlow: 无绑定 session，无法切换分支')
    await gitApi.checkout(currentSessionId.value, name)
    transition('landing') // branch-popover→landing
  }

  /**
   * openBranchModal —— branch-popover→branch-modal（点「创建并检出新分支」）。
   * 守卫：来源非 branch-popover → 非法转换抛错回 idle（AC-3.8/E9）。
   */
  function openBranchModal(): void {
    if (state.value !== 'branch-popover') {
      state.value = 'idle'
      throw new Error('NewTaskFlow: 创建分支 modal 仅可从 branch-popover 进入')
    }
    transition('branch-modal')
  }

  /**
   * submitCreateBranch —— 创建并检出分支（§4.4，#7）。
   *
   * 数据流：branch-modal → gitApi.createBranch(sessionId,name) → 成功 transition('landing')。
   * - 飞行中守卫（AC-7.9/T6.6）：branchCreateInFlight 标记，重复提交直接 return
   * - 孤儿 promise 守卫（AC-7.9/T6.7）：Esc 已让 state 离开 branch-modal 后台 resolve → 忽略不 transition/不回灌
   * - 失败留 modal（D-7/AC-7.3）：createBranch reject→错误向上抛（state 不变，组件 catch 显错可重试）
   */
  async function submitCreateBranch(name: string): Promise<void> {
    if (!currentSessionId.value) throw new Error('NewTaskFlow: 无绑定 session，无法创建分支')
    if (branchCreateInFlight.value) return // T6.6 飞行中守卫
    branchCreateInFlight.value = true
    try {
      await gitApi.createBranch(currentSessionId.value, name)
      // T6.7 孤儿 promise 守卫：Esc 已切走→state≠branch-modal→忽略结果（不重复 transition、不回灌 chip）
      if (state.value !== 'branch-modal') return
      transition('landing') // branch-modal→landing（创建成功落回）
    } finally {
      branchCreateInFlight.value = false
    }
  }

  /** 任意 overlay→landing（Esc/点外）。同一时刻只一层（AC-3.9）。 */
  function closeOverlay(): void {
    transition('landing') // dir-popover/branch-popover/dir-dialog/branch-modal → landing（均合法）
  }

  /** landing/overlay→cancelled（overlay 打开时切 session，AC-3.10）。 */
  function cancelFlow(): void {
    transition('cancelled')
  }

  /** cancelled→landing（重选空 session 复活，AC-3.3）。 */
  function reenterFlow(): void {
    transition('landing')
  }

  /** landing→completed（首条消息成功，终态）。completed 后实例销毁，⌘N 再触发重建（AC-3.6/3.12）。 */
  function completeFlow(): void {
    transition('completed')
  }

  return {
    state: readonly(state),
    currentSession: readonly(currentSession),
    currentSessionId,
    currentCwd,
    gitInfo,
    isInflight: readonly(createInFlight),
    isBranchCreating: readonly(branchCreateInFlight),
    isOverlay: computed(() => OVERLAY_STATES.has(state.value)),
    startFlow,
    openDirPopover,
    openBranchPopover,
    selectWorkspace,
    openDirDialog,
    selectBranch,
    confirmDirtySwitch,
    openBranchModal,
    submitCreateBranch,
    closeOverlay,
    cancelFlow,
    reenterFlow,
    completeFlow,
  }
}
