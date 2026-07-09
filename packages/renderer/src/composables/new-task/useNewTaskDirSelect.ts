/**
 * useNewTaskDirSelect —— 工作区目录选择 + OS 原生对话框（从 useNewTaskFlow 拆出，单一变化轴「选目录」）。
 *
 * 职责（§4.2，延迟 create 语义）：
 * - openDirPopover：landing→dir-popover（overlay 互斥：已开 branch-popover 先归 landing）。
 * - selectWorkspace：dir-popover 选已有 workspace（记 pendingCwd，不 create session）。
 * - openDirDialog：打开 OS 目录选择器（pickDirectory IPC），选中记 pendingCwd；取消落回 dir-popover。
 *
 * 不含：状态机定义/转换表（在 useNewTaskFlowState）、分支操作（在 useNewTaskBranch）、
 * 发送/创建 session 编排（在 useNewTaskFlow）。
 *
 * 依赖方向：lib/ipc(pickDirectory) + useNewTaskFlowState（transition + refs）。
 */
import { pickDirectory } from '@/lib/ipc'
import { useWorkspaceStore } from '@/stores/workspace'
import { transition, useNewTaskFlowState } from './useNewTaskFlowState'

/**
 * @param currentCwd 当前 flow 的 cwd（chip 回灌判定：cwd 未变则 noop 仅关 popover）
 */
export function useNewTaskDirSelect(
  currentCwd: () => string | null,
): {
  openDirPopover: () => void
  selectWorkspace: (cwd: string) => Promise<void>
  openDirDialog: () => Promise<void>
} {
  const { state, pendingCwd } = useNewTaskFlowState()
  const workspaceStore = useWorkspaceStore()

  /** landing→dir-popover（点 directory chip）。overlay 互斥：已开 branch-popover 时先归 landing 再开。 */
  function openDirPopover(): void {
    // overlay 互斥：已开 branch-popover 时先归 landing。branch-popover→landing 在 ALLOWED 表内合法，
    // 走 transition（带守卫）而非直置后门——保持状态变更统一走守卫表，杜绝绕过。
    if (state.value === 'branch-popover') transition('landing')
    transition('dir-popover')
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
    if (cwd === currentCwd()) {
      transition('landing') // dir-popover→landing（关 popover）
      return
    }
    pendingCwd.value = cwd
    transition('landing') // dir-popover→landing（关 popover，chip 回灌新 cwd）
    // 热更新最近工作区列表：选中后 record 写入 runtime，刷新后的 records 回补 store，
    // 下次打开 popover 即可见（无需重启）。失败静默降级（不阻断选目录流程）。
    void workspaceStore.record(cwd)
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
      // 热更新（同 selectWorkspace）：选中后 record 刷新列表，下次打开即可见
      void workspaceStore.record(result.path)
    } catch (e) {
      // E5：IPC 招错 → 落回 dir-popover + 重抛（调用方显错 toast），不卡 dir-dialog
      transition('dir-popover')
      throw e
    }
  }

  return {
    openDirPopover,
    selectWorkspace,
    openDirDialog,
  }
}
