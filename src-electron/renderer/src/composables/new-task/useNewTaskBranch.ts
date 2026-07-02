/**
 * useNewTaskBranch —— git 分支操作（从 useNewTaskFlow 拆出，单一变化轴「分支切换/创建」）。
 *
 * 职责（§4.3/§4.4，#6/#7）：
 * - selectBranch：选干净分支直切（gitApi.checkout）。reject 留 branch-popover，成功→landing。
 * - confirmDirtySwitch：dirty 分支二次确认后切走（git 默认携带未提交改动，不 stash）。
 * - submitCreateBranch：创建并检出分支（gitApi.createBranch）。飞行中守卫 + 孤儿 promise 守卫。
 * - openBranchModal：branch-popover→branch-modal。
 * - openBranchPopover：landing→branch-popover（含 git 守卫 + overlay 互斥）。
 * - branchCreateInFlight：submitCreateBranch 飞行中标记（AC-7.9）。
 *
 * 不含：状态机定义/转换表（在 useNewTaskFlowState）、目录选择（在 useNewTaskDirSelect）、
 * 发送/创建 session 编排（在 useNewTaskFlow）。
 *
 * 依赖方向：@/api(git) + useNewTaskFlowState（transition + refs + gitInfo）。
 */
import { git as gitApi } from '@/api'
import {
  transition,
  setFlowState,
  setBranchCreateInFlight,
  useNewTaskFlowState,
  type GitInfo,
} from './useNewTaskFlowState'

/**
 * @param currentSessionId 当前 flow 绑定 session 的 id（无绑定→分支操作抛错守卫）
 * @param gitInfo 当前 flow 的 git 派生（openBranchPopover 守卫：非 git 目录不可达）
 */
export function useNewTaskBranch(
  currentSessionId: () => string | null,
  gitInfo: () => GitInfo | null,
): {
  isBranchCreating: ReturnType<typeof useNewTaskFlowState>['branchCreateInFlight']
  openBranchPopover: () => void
  openBranchModal: () => void
  selectBranch: (name: string) => Promise<void>
  confirmDirtySwitch: (name: string) => Promise<void>
  submitCreateBranch: (name: string) => Promise<void>
} {
  const { state, branchCreateInFlight } = useNewTaskFlowState()

  /**
   * landing→branch-popover（点 branch chip）。
   * 守卫：gitInfo==null（非 git 目录）→ 抛错回 idle，popover 不可达（AC-3.7/UC-7）。
   * overlay 互斥：已开 dir-popover 时先归 landing 再开（AC-3.2 至多 1 个 overlay）。
   */
  function openBranchPopover(): void {
    if (gitInfo() == null) {
      // 直接置 idle（非 transition，因为 throw 前状态已被守卫语义清空）
      setFlowState('idle')
      throw new Error('NewTaskFlow: 非 git 目录不可打开分支选择')
    }
    if (state.value === 'dir-popover') setFlowState('landing')
    transition('branch-popover')
  }

  /**
   * openBranchModal —— branch-popover→branch-modal（点「创建并检出新分支」）。
   * 守卫：来源非 branch-popover → 非法转换抛错回 idle（AC-3.8/E9）。
   */
  function openBranchModal(): void {
    if (state.value !== 'branch-popover') {
      setFlowState('idle')
      throw new Error('NewTaskFlow: 创建分支 modal 仅可从 branch-popover 进入')
    }
    transition('branch-modal')
  }

  /**
   * selectBranch —— 选干净分支直切（§4.3，#6）。
   * checkout reject（冲突/分支不存在）→ 向上抛，state 留 branch-popover 显错（AC-6.4）；成功→landing。
   */
  async function selectBranch(name: string): Promise<void> {
    if (!currentSessionId()) throw new Error('NewTaskFlow: 无绑定 session，无法切换分支')
    await gitApi.checkout(currentSessionId()!, name) // reject 则留 branch-popover
    transition('landing') // branch-popover→landing
  }

  /**
   * confirmDirtySwitch —— dirty 分支二次确认后切走（§4.3，AC-6.2，#6）。
   * v1 选「留在工作区」：仅 git checkout（git 默认携带未提交改动），不 stash、不丢弃。
   * 与 selectBranch 同语义（确认动作在组件 inline 条，composable 只执行切走）。
   */
  async function confirmDirtySwitch(name: string): Promise<void> {
    if (!currentSessionId()) throw new Error('NewTaskFlow: 无绑定 session，无法切换分支')
    await gitApi.checkout(currentSessionId()!, name)
    transition('landing') // branch-popover→landing
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
    if (!currentSessionId()) throw new Error('NewTaskFlow: 无绑定 session，无法创建分支')
    if (branchCreateInFlight.value) return // T6.6 飞行中守卫
    setBranchCreateInFlight(true)
    try {
      await gitApi.createBranch(currentSessionId()!, name)
      // T6.7 孤儿 promise 守卫：Esc 已切走→state≠branch-modal→忽略结果（不重复 transition、不回灌 chip）
      if (state.value !== 'branch-modal') return
      transition('landing') // branch-modal→landing（创建成功落回）
    } finally {
      setBranchCreateInFlight(false)
    }
  }

  return {
    isBranchCreating: branchCreateInFlight,
    openBranchPopover,
    openBranchModal,
    selectBranch,
    confirmDirtySwitch,
    submitCreateBranch,
  }
}
