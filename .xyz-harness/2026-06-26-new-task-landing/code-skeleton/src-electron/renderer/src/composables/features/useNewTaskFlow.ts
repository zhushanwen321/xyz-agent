/**
 * useNewTaskFlow —— 新建任务流程编排 composable（#3，§3.3，单实例 Q2=A）。
 *
 * 职责：NewTaskFlowState 状态机（8 态）+ overlay 嵌套 + Esc 优先级 + cwd 调度。
 * 深模块（§5）：调用方只看 state（只读）+ 动作方法，状态机守卫/转换表内部封装。
 *
 * 依赖方向（§2 严格边界）：api/domains（session/git）+ lib/utils（派生）+ lib/ipc（pickDirectory）+ stores/session。
 * 不直接 import transport（经 api/domains）。
 *
 * 接线层级（§3.3）：动作方法体 = 状态转换 + 对注入依赖的真调用（sessionApi/gitApi/ipc），
 * 链路末端叶子逻辑（如 spawn 失败回滚、错误 toast）由调用方/Vue 错误边界处理，不在 composable 内组装。
 *
 * NFR④#3（§3.8 骨架约束）：每次 state 转换 log debug + 非法转换计数器（反推状态机 bug）。
 * 骨架用模块级 illegalTransitionCount 计数 + 注释标记 logger 接线点（实装在⑥Wave）。
 */
import { ref, computed, readonly } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { session as sessionApi, git as gitApi } from '@/api'
import { resolveDefaultCwd } from '@/lib/utils'
import { pickDirectory } from '@/lib/ipc'
import { useSessionStore } from '@/stores/session'
import type { GitInfo } from '@/types'

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
  completed: [], // 终态，无出口
  cancelled: ['landing'], // reenterFlow 复活
}

// ── 模块级单实例状态（Q2=A 单实例：composable 模块单例）──
const state: Ref<NewTaskFlowState> = ref('idle')
const currentSessionId: Ref<string | null> = ref(null)
/** 当前 flow 绑定 session 的 cwd（selectWorkspace 比对用，保持②Session.cwd 不变式） */
const currentCwd: Ref<string | null> = ref(null)
/** startFlow in-flight 标记（AC-1.5 幂等：双击并发只建 1 session） */
const createInFlight: Ref<boolean> = ref(false)
/** submitCreateBranch 飞行中标记（AC-7.9 防重复提交） */
const branchCreateInFlight: Ref<boolean> = ref(false)

/** NFR④#3：非法状态转换计数器（反推状态机 bug；实装期接 logger debug 输出） */
let illegalTransitionCount = 0

export function useNewTaskFlow() {
  const session = useSessionStore()

  /**
   * gitInfo（UC-7 chip 可见性派生）：从当前活跃 session 的 gitBranch 派生。
   * null → 非 git 目录，branch chip 隐藏且 branch-popover/branch-modal 不可达（状态机守卫 AC-3.7）。
   */
  const gitInfo: ComputedRef<GitInfo | null> = computed(() => {
    const s = session.activeSummary.value
    if (!s) return null
    return { branch: s.gitBranch ?? null, isRepo: s.gitBranch != null }
  })

  /**
   * 状态转换（带守卫）。非法转换 → 计数 + 回 idle + 抛错（Vue 错误边界兼底，AC-3.11）。
   * NFR④#3：此处为 logger debug 接线点（每次转换 log from→to，实装在⑥Wave）。
   */
  function transition(target: NewTaskFlowState): void {
    const from = state.value
    if (!ALLOWED[from].includes(target)) {
      illegalTransitionCount += 1
      state.value = 'idle'
      throw new Error(`NewTaskFlow 非法状态转换: ${from} → ${target}`)
    }
    state.value = target
  }

  /**
   * startFlow —— 触发新建（§4.1 主流程）。
   *
   * 数据流：触发点 → startFlow → resolveDefaultCwd(sessions) → sessionApi.create(cwd) → state=landing。
   * - in-flight 标记防重复（E1/AC-1.5）：create 飞行中再触发 → 忽略
   * - cwd=undefined（首次启动，AC-1.7 延迟 create）→ 不调 create，currentSessionId=null，chip 空态+发送 disabled；
   *   用户选目录后 selectWorkspace/openDirDialog 触发 create(newCwd)
   * - cwd 合法（常态）→ create(cwd) 绑定 sessionId，进 landing
   */
  async function startFlow(cwd?: string): Promise<void> {
    if (createInFlight.value) return // E1 幂等保护（AC-1.5）
    const effectiveCwd = cwd ?? resolveDefaultCwd(session.list.value)
    // 首次启动：无可用 cwd → 延迟 create，仅进 landing 待选目录（AC-1.7）
    if (!effectiveCwd) {
      transition('landing') // idle→landing
      currentSessionId.value = null
      currentCwd.value = null
      return
    }
    createInFlight.value = true
    try {
      // [内] 真接线 sessionApi.create（常态路径）；spawn 失败/非法 cwd 由 runtime reject → 调用方 catch（E2/E3）
      const created = await sessionApi.create(effectiveCwd)
      currentSessionId.value = created.id
      currentCwd.value = created.cwd
      transition('landing') // idle→landing
    } finally {
      createInFlight.value = false
    }
  }

  /** landing→dir-popover（点 directory chip） */
  function openDirPopover(): void {
    transition('dir-popover')
  }

  /**
   * landing→branch-popover（点 branch chip）。
   * 守卫：gitInfo==null（非 git 目录）→ 抛错回 idle，popover 不可达（AC-3.7/UC-7）。
   */
  function openBranchPopover(): void {
    if (gitInfo.value == null) {
      // E6 非 git 目录：状态机守卫拦截，回 idle
      illegalTransitionCount += 1
      state.value = 'idle'
      throw new Error('NewTaskFlow: 非 git 目录不可打开分支选择')
    }
    transition('branch-popover')
  }

  /**
   * selectWorkspace —— dir-popover 选已有 workspace（§4.2）。
   *
   * 不变式（保持②Session.cwd）：cwd 变了 → delete 空旧 session + create 新 session(newCwd)；
   * cwd 未变 → noop（仅关 popover）。dir-popover→landing。
   */
  async function selectWorkspace(cwd: string): Promise<void> {
    if (cwd === currentCwd.value) {
      transition('landing') // noop：仅关 popover
      return
    }
    // [内] 真接线：删空旧 session + 建新 session(newCwd)
    if (currentSessionId.value) {
      await sessionApi.remove(currentSessionId.value)
    }
    const created = await sessionApi.create(cwd)
    currentSessionId.value = created.id
    currentCwd.value = created.cwd
    transition('landing') // dir-popover→landing（chip 回灌新 cwd）
  }

  /**
   * openDirDialog —— 打开 OS 目录选择器（§4.2，Tier 2 IPC 证伪点）。
   *
   * 数据流：dir-popover → ipc.pickDirectory（preload electronAPI）→ OS dialog →
   * 选中→delete+create(newCwd)+landing / 取消→落回 dir-popover（AC-5.3）/ IPC 抛错→留 dir-popover 显错（E5）。
   */
  async function openDirDialog(): Promise<void> {
    transition('dir-dialog') // dir-popover→dir-dialog
    // [adapter] 真引 preload electronAPI（lib/ipc.pickDirectory）；getFocusedWindow null → {canceled:true}（E5）
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
      const created = await sessionApi.create(result.path)
      currentSessionId.value = created.id
      currentCwd.value = created.cwd
    }
    transition('landing') // dir-dialog→landing（chip 回灌新 cwd）
  }

  /**
   * selectBranch —— 选干净分支直切（§4.3）。
   * [内] 真接线 gitApi.checkout；branch-popover→landing。失败留 popover 显错（E8，由调用方 catch）。
   */
  async function selectBranch(name: string): Promise<void> {
    if (!currentSessionId.value) throw new Error('NewTaskFlow: 无绑定 session，无法切换分支')
    await gitApi.checkout(currentSessionId.value, name) // [内] 真接线
    transition('landing') // branch-popover→landing（chip 回灌新分支）
  }

  /**
   * confirmDirtySwitch —— dirty 分支二次确认后切走（§4.3，AC-6.2）。
   * 未提交改动留工作区（v1 不 stash）。checkout 冲突 → reject 留 popover 显错（E8）。
   */
  async function confirmDirtySwitch(name: string): Promise<void> {
    if (!currentSessionId.value) throw new Error('NewTaskFlow: 无绑定 session，无法切换分支')
    await gitApi.checkout(currentSessionId.value, name) // [内] 真接线
    transition('landing')
  }

  /**
   * openBranchModal —— branch-popover→branch-modal（点「创建并检出新分支」）。
   * 守卫：来源非 branch-popover → 非法转换抛错（AC-3.8）。
   */
  function openBranchModal(): void {
    if (state.value !== 'branch-popover') {
      illegalTransitionCount += 1
      state.value = 'idle'
      throw new Error('NewTaskFlow: 创建分支 modal 仅可从 branch-popover 进入')
    }
    transition('branch-modal')
  }

  /**
   * submitCreateBranch —— 创建并检出分支（§4.4，跨前后端最复杂链路）。
   *
   * 数据流：submitCreateBranch → gitApi.createBranch → WS git.createBranch →
   * GitService.createBranch → IGitExecutor.exec(checkout,[-b,name]) → 成功 landing / 失败留 modal（D-7）。
   * - 飞行中 disabled 防重复（AC-7.9）
   * - 失败留 modal 显错，不关 modal 可重试（D-7/AC-7.3）；分支名非法/已存在→reject（E10），超时→reject（E11）
   */
  async function submitCreateBranch(name: string): Promise<void> {
    if (branchCreateInFlight.value) return // AC-7.9 防重复
    if (!currentSessionId.value) throw new Error('NewTaskFlow: 无绑定 session，无法创建分支')
    branchCreateInFlight.value = true
    try {
      await gitApi.createBranch(currentSessionId.value, name) // [内] 真接线
      transition('landing') // branch-modal→landing（chip 回灌新分支）；失败则不转换，留 modal（D-7）
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

  /** cancelled→landing（重选空 session 复活，AC-3.3）。单实例：currentSessionId 由调用方更新。 */
  function reenterFlow(): void {
    transition('landing')
  }

  /** landing→completed（首条消息成功，终态）。completed 后实例销毁，⌘N 再触发重建（AC-3.6/3.12）。 */
  function completeFlow(): void {
    transition('completed')
  }

  return {
    state: readonly(state),
    currentSessionId: readonly(currentSessionId),
    gitInfo,
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
