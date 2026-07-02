/**
 * useNewTaskFlow —— 新建任务流程编排 composable（#3，§3.3，单实例 Q2=A，薄编排器）。
 *
 * 职责（编排，非状态机实现）：NewTaskFlow 横切编排骨架——compose 状态机 + 分支 + 选目录三子 composable，
 * 自身仅保留跨子 composable 的编排动作：
 * - startFlow：进 landing（销毁重建终态 / in-flight 守卫 / presetCwd / 不变量强制清 activeId）。
 * - submitFirstMessage：landing 态首发提交（create session + apply 模型/思考等级 + 载入 panel + 发送）。
 * - presetCwd / setPendingModel：landing 态回灌选定值（create session 后 apply）。
 * - closeOverlay / cancelFlow / reenterFlow / completeFlow：薄转换封装。
 * - computed 视图（currentSessionId/currentCwd/currentModel/gitInfo/isInflight/isOverlay/isActive）。
 *
 * 状态机实现见 useNewTaskFlowState；git 分支见 useNewTaskBranch；选目录见 useNewTaskDirSelect。
 *
 * 依赖方向（§2 严格边界）：api/domains（session）+ lib/utils（resolveDefaultCwd）+ stores/session/panel/navigation
 * + composables/features(useChat/useModel) + composables/new-task/*（子 composable）。
 * 不直接 import transport（经 api/domains）。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { session as sessionApi } from '@/api'
import { resolveDefaultCwd, deriveSessionLabel } from '@/lib/utils'
import { useSessionStore } from '@/stores/session'
import { usePanelStore } from '@/stores/panel'
import { useNavigationStore } from '@/stores/navigation'
import { useChat } from '@/composables/features/useChat'
import { useModel } from '@/composables/features/useModel'
import {
  useNewTaskFlowState,
  transition,
  setFlowState,
  bindCurrentSession,
  setCreateInFlight,
  OVERLAY_STATES,
  ACTIVE_STATES,
  type GitInfo,
} from '@/composables/new-task/useNewTaskFlowState'
import { useNewTaskBranch } from '@/composables/new-task/useNewTaskBranch'
import { useNewTaskDirSelect } from '@/composables/new-task/useNewTaskDirSelect'

// 重导出供既有 import 消费（types + reset 原从本模块导入，保持非破坏）
export type { NewTaskFlowState, GitInfo } from '@/composables/new-task/useNewTaskFlowState'
export { resetNewTaskFlow } from '@/composables/new-task/useNewTaskFlowState'

export function useNewTaskFlow() {
  const session = useSessionStore()
  const panel = usePanelStore()
  const navigation = useNavigationStore()
  const chat = useChat()
  // 模型切换 + 思考等级设置的 RPC + 乐观更新编排（features 层，ADR-0028）。
  // landing 态 apply 逻辑统一走此 composable，消除原先与 useComposerModelThinking 的重复。
  const { switchModel, setThinkingLevel } = useModel()

  const {
    state,
    currentSession,
    pendingCwd,
    pendingModel,
    createInFlight,
  } = useNewTaskFlowState()

  /** 当前 flow 绑定 session 的 id（统一延迟 create 后，landing 态恒为 null） */
  const currentSessionId: ComputedRef<string | null> = computed(
    () => currentSession.value?.id ?? null,
  )
  /** 当前 flow 工作的 cwd（chip 回灌）：session 已建用 session.cwd，否则用 landing 选定的 pendingCwd */
  const currentCwd: ComputedRef<string | null> = computed(
    () => currentSession.value?.cwd ?? pendingCwd.value,
  )
  /**
   * 当前 flow 选定模型（Composer 显示用）：session 已建用 session.modelId，
   * 否则用 landing 选定的 pendingModel。两者均空时 Composer 自行回退全局 defaultModel。
   */
  const currentModel: ComputedRef<string | null> = computed(
    () => currentSession.value?.modelId ?? pendingModel.value,
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
      setFlowState('idle')
      bindCurrentSession(null)
    }
    if (createInFlight.value) return // submitFirstMessage 飞行中，忽略重复触发
    // 幂等：已 landing 态再 startFlow（initApp 重试 / 多次 ⌘N）→ 不翻 state（landing→landing
    // 非法），只刷新 cwd + 不变量。避免 loadSessions 失败后 initApp 重试时 transition 抛错。
    if (state.value !== 'landing') {
      transition('landing') // idle→landing
    }
    // 进 landing：预设 cwd（有则 chip 所见即所得，无则空 chip 态）
    pendingCwd.value = presetCwd ?? null
    pendingModel.value = null
    bindCurrentSession(null)
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
   *
   * thinkingLevel：landing 态 Composer 传入用户选定（或切模型自动重置）的思考等级，
   * create session 后 apply（session.setThinkingLevel）。undefined 表示用户未操作，
   * 用 runtime 默认。
   */
  async function submitFirstMessage(text: string, thinkingLevel?: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (state.value !== 'landing') {
      throw new Error('NewTaskFlow: 非 landing 态不可首发提交')
    }
    if (createInFlight.value) return
    setCreateInFlight(true)
    try {
      // 未选目录直接发送（用默认 cwd 兑底 create），或重试场景已绑定
      if (!currentSession.value) {
        const cwd = pendingCwd.value ?? resolveDefaultCwd(session.list)
        // session 名默认取首条提示词前 10 字符（codePoint 计 + 省略号），取代旧的 basename(cwd)
        const label = deriveSessionLabel(trimmed)
        const created = await sessionApi.create(cwd, label)
        bindCurrentSession(created)
        session.appendSession(created)
        // apply landing 态选定的模型（session 已 create，可调 model.switch RPC）。
        // pendingModel 为 "provider/modelId" 复合串；未选（null）则用 runtime 默认，不切换。
        // RPC + 乐观更新编排统一走 features/useModel（ADR-0028），消除重复。
        const pending = pendingModel.value
        if (pending) {
          const slashIdx = pending.indexOf('/')
          if (slashIdx > 0) {
            const provider = pending.slice(0, slashIdx)
            const modelId = pending.slice(slashIdx + 1)
            await switchModel(created.id, provider, modelId)
          }
        }
        // apply landing 态选定的思考等级（session 已 create，可调 setThinkingLevel RPC）
        if (thinkingLevel) {
          await setThinkingLevel(created.id, thinkingLevel)
        }
      }
      // 载入 panel + 设 activeId（预建或刚建统一处理）
      session.activeId = currentSession.value!.id
      panel.loadSession(panel.activePanelId, currentSession.value!.id)
      navigation.push({ view: 'chat', sessionId: currentSession.value!.id })
      // activeId 已设 → useChat.send 能取到 sid
      await chat.send(trimmed)
      transition('completed') // landing→completed（首发成功，终态）
    } finally {
      setCreateInFlight(false)
    }
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
   * setPendingModel —— landing 态记录用户选定但尚未 apply 的模型。
   *
   * landing 态 session 尚未 create，无法调 model.switch RPC。记 pendingModel 供 Composer
   * 显示所选模型（currentModel computed），首发提交 submitFirstMessage create session 后 apply。
   * 守卫：仅 landing 态生效（其他态 noop，避免污染 overlay/终态流程）。
   * payload 为 "provider/modelId" 复合串（ModelSelectPopover emit 的格式约定）。
   */
  function setPendingModel(model: string): void {
    if (state.value !== 'landing') return
    pendingModel.value = model
  }

  // ── compose 子 composable（分支 + 选目录）── 传 computed 值的 getter，解耦于父内部 ──
  const branch = useNewTaskBranch(
    () => currentSessionId.value,
    () => gitInfo.value,
  )
  const dirSelect = useNewTaskDirSelect(() => currentCwd.value)

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
    state,
    currentSession,
    currentSessionId,
    currentCwd,
    currentModel,
    gitInfo,
    isInflight: createInFlight,
    isBranchCreating: branch.isBranchCreating,
    isOverlay: computed(() => OVERLAY_STATES.has(state.value)),
    isActive: computed(() => ACTIVE_STATES.has(state.value)),
    startFlow,
    submitFirstMessage,
    presetCwd,
    setPendingModel,
    openDirPopover: dirSelect.openDirPopover,
    openBranchPopover: branch.openBranchPopover,
    selectWorkspace: dirSelect.selectWorkspace,
    openDirDialog: dirSelect.openDirDialog,
    selectBranch: branch.selectBranch,
    confirmDirtySwitch: branch.confirmDirtySwitch,
    openBranchModal: branch.openBranchModal,
    submitCreateBranch: branch.submitCreateBranch,
    closeOverlay,
    cancelFlow,
    reenterFlow,
    completeFlow,
  }
}
