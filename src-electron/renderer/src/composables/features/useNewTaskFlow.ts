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
import { usePanelStore } from '@/stores/panel'
import { useNavigationStore } from '@/stores/navigation'
import { useChat } from '@/composables/features/useChat'

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
 * 活跃态集合（landing + 全部 overlay；排除 idle/completed/cancelled）。
 * Workspace 渲染守卫用：统一延迟 create 下，flow 活跃期间 activeId 恒 null，
 * 但 UI 须保持 Landing 挂载——否则用户点 chip 进 overlay 态（dir-popover/dir-dialog…）
 * 会瞬间卸载 Landing → 跳兜底空态页，系统目录选择器视觉上"没弹"。isOverlay ⊂ isActive。
 */
const ACTIVE_STATES: ReadonlySet<NewTaskFlowState> = new Set([
  'landing',
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
/** 当前 flow 绑定的 session（统一延迟 create 后，landing 态恒为 null，首发提交 submitFirstMessage 才绑定） */
const currentSession: Ref<SessionSummary | null> = ref(null)
/** landing 态用户选定但尚未 create 的 cwd（选目录只记值不建 session；首发提交才用它 create）。null=空 chip 态 */
const pendingCwd: Ref<string | null> = ref(null)
/** submitFirstMessage in-flight 标记（双击并发只建 1 session） */
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
  pendingCwd.value = null
  createInFlight.value = false
  branchCreateInFlight.value = false
}

export function useNewTaskFlow() {
  const session = useSessionStore()
  const panel = usePanelStore()
  const navigation = useNavigationStore()
  const chat = useChat()

  /** 当前 flow 绑定 session 的 id（统一延迟 create 后，landing 态恒为 null） */
  const currentSessionId: ComputedRef<string | null> = computed(
    () => currentSession.value?.id ?? null,
  )
  /** 当前 flow 工作的 cwd（chip 回灌）：session 已建用 session.cwd，否则用 landing 选定的 pendingCwd */
  const currentCwd: ComputedRef<string | null> = computed(
    () => currentSession.value?.cwd ?? pendingCwd.value,
  )

  /**
   * gitInfo（UC-7 chip 可见性派生）：从当前 flow 绑定 session 的 gitBranch 派生。
   * 统一延迟 create 后 landing 态无 session → null → branch chip 隐藏（分支切换需已建 session）。
   */
  const gitInfo: ComputedRef<GitInfo | null> = computed(() => {
    const s = currentSession.value
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
   * startFlow —— 触发新建（§4.1 主流程，统一延迟 create）。
   *
   * 需求修正：点「新建任务」后**不立即 create session**，只进 landing 空 chip 态。
   * 首次/非首次一致（推翻原「触发即创建」+ G1.1「非首次沿用上次 cwd」）。
   * session 由首发提交 submitFirstMessage 创建；选目录只记 pendingCwd 不建 session。
   * - completed 终态再触发→先销毁重建 idle（AC-3.12）再进 landing
   * - createInFlight 守卫：submitFirstMessage 飞行中再触发→忽略（防并发重复建 session）
   * - presetCwd：可选，进 landing 时预设 chip 的 cwd（initApp 用最近 session 目录预填）。
   *   未传→空 chip 态（默认）；传值→chip 所见即所得（G1.1「沿用目录做新任务」）。
   *
   * 不变量强制（根治 new-task 渲染撕裂）：flow 进 landing 时，编排层主动清空
   * activeId + active panel 的 leaf.sessionId。此前该不变量只写在注释（ACTIVE_STATES
   * 注释「flow 活跃期间 activeId 恒 null」），从未被代码执行——会话中点新建时旧
   * sessionId 残留，Panel.vue 第一条 v-if 用旧 sessionId 命中 MessageStream，导致
   * 「页面不跳转、只 composer 消失」。此处清空后 sessionId=null → Landing 正确渲染。
   */
  async function startFlow(presetCwd?: string): Promise<void> {
    // 终态重建（AC-3.12）：completed 后 ⌘N 销毁重建
    if (state.value === 'completed') {
      state.value = 'idle'
      currentSession.value = null
      pendingCwd.value = null
    }
    if (createInFlight.value) return // submitFirstMessage 飞行中，忽略重复触发
    // 幂等：已 landing 态再 startFlow（initApp 重试 / 多次 ⌘N）→ 不翻 state（landing→landing
    // 非法），只刷新 cwd + 不变量。避免 loadSessions 失败后 initApp 重试时 transition 抛错。
    if (state.value !== 'landing') {
      transition('landing') // idle→landing
    }
    // 进 landing：预设 cwd（有则 chip 所见即所得，无则空 chip 态）
    pendingCwd.value = presetCwd ?? null
    currentSession.value = null
    // 强制不变量：landing 态无 session 绑定。清 activeId + active panel leaf.sessionId，
    // 让 Panel 的 sessionId prop 变 null → 渲染落到 Landing（而非旧会话 MessageStream）。
    session.activeId = null
    panel.loadSession(panel.activePanelId, null)
  }

  /**
   * submitFirstMessage —— landing 态首发提交：载入 panel + 发消息。
   *
   * 预创建后 session 已在选目录时建立，这里只负责载入 panel + 发送。
   * - 无绑定 session（未选目录直接输入发送，用 resolveDefaultCwd 兑底 create）→ create 后发送
   * - 已绑定 session（选过目录预建 / 重试场景）→ 直接载入 + 发送，不重复 create
   */
  async function submitFirstMessage(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (state.value !== 'landing') {
      throw new Error('NewTaskFlow: 非 landing 态不可首发提交')
    }
    if (createInFlight.value) return
    createInFlight.value = true
    try {
      // 未选目录直接发送（用默认 cwd 兑底 create），或重试场景已绑定
      if (!currentSession.value) {
        const cwd = pendingCwd.value ?? resolveDefaultCwd(session.list)
        const created = await sessionApi.create(cwd)
        currentSession.value = created
        session.appendSession(created)
      }
      // 载入 panel + 设 activeId（预建或刚建统一处理）
      session.activeId = currentSession.value!.id
      panel.loadSession(panel.activePanelId, currentSession.value!.id)
      navigation.push({ view: 'chat', sessionId: currentSession.value!.id })
      // activeId 已设 → useChat.send 能取到 sid
      await chat.send(trimmed)
      transition('completed') // landing→completed（首发成功，终态）
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
   * presetCwd —— landing 态回灌预设 cwd（启动编排用，G1.1「沿用最近 session 目录」）。
   *
   * 与 startFlow(presetCwd) 同语义（写 pendingCwd → chip 所见即所得），但用于 startFlow
   * 已先进 landing、cwd 还需异步加载后才确定的场景：
   * initApp 必须在 await loadSessions() **之前**同步 startFlow() 进 landing，否则
   * 「连接成功→AppShell 渲染 Landing」与 startFlow 之间会有 flow.state=idle 的启动窗口，
   * 此时点 directory chip 触发 idle→dir-popover 非法转换抛错。故顺序定为先 startFlow（空 chip）
   * → loadSessions → presetCwd 回灌。
   *
   * 守卫：仅 landing 态生效（其他态 noop，避免污染 overlay/终态流程）。
   */
  function presetCwd(cwd: string): void {
    if (state.value !== 'landing') return
    pendingCwd.value = cwd
  }

  /**
   * selectWorkspace —— dir-popover 选已有 workspace（§4.2）。
   *
   * 延迟 create：选目录只记 pendingCwd（chip 回灌所见即所得），不 create session。
   * session 由首发提交 submitFirstMessage 创建。slash 浮层在 landing 态用 config.skills
   * 全局扫描结果（CommandPopover 双源），不再依赖预建 session 取真实命令。
   * - cwd 未变→noop（仅关 popover）
   * - cwd 变→记 pendingCwd + 关 popover
   */
  async function selectWorkspace(cwd: string): Promise<void> {
    if (cwd === currentCwd.value) {
      transition('landing') // dir-popover→landing（关 popover）
      return
    }
    pendingCwd.value = cwd
    transition('landing') // dir-popover→landing（关 popover，chip 回灌新 cwd）
  }

  /**
   * openDirDialog —— 打开 OS 目录选择器（§4.2）。
   *
   * 延迟 create：选中目录只记 pendingCwd，不 create session（同 selectWorkspace 语义）。
   * 选中→记 pendingCwd + landing；取消→落回 dir-popover（AC-5.3）。
   * E5 IPC 招错→落回 dir-popover + 向上抛（调用方接 toast，AC-5.6）。
   */
  async function openDirDialog(): Promise<void> {
    transition('dir-dialog') // dir-popover→dir-dialog
    try {
      const result = await pickDirectory()
      if (result.canceled || !result.path) {
        transition('dir-popover') // 取消落回（AC-5.3）
        return
      }
      pendingCwd.value = result.path
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
    isActive: computed(() => ACTIVE_STATES.has(state.value)),
    startFlow,
    submitFirstMessage,
    presetCwd,
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
