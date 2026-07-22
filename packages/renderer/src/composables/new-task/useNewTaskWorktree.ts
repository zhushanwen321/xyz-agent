/**
 * useNewTaskWorktree —— worktree 创建的 flow 级封装（modal 开关 + base 分支选择）。
 *
 * 职责（薄编排器）：
 * - createWorktree：调 worktreeApi.create RPC 创建 worktree（branch/baseBranch/workspaceHint 透传），
 *   成功后记 pendingCwd（chip 回灌）+ 关 overlay 回 landing；失败向上抛（由 CreateWorktreeModal
 *   接住按 code 切 error / exists 态）。
 * - startCreateWorktree：landing→worktree-modal 转换的语义入口（由 UI 触发打开 modal）。
 *
 * 不含：状态机定义（在 useNewTaskFlowState）、modal 内部五态机（CreateWorktreeModal 自管）、
 * 分支名校验（在 CreateWorktreeModal）。
 *
 * 依赖方向：api/domains/worktree（RPC）+ useNewTaskFlowState（transition + refs）。
 *
 * @deprecated 当前无消费方。CreateWorktreeModal 内部自管五态机 + 直接调 worktreeApi.create，
 * 不经此 composable。createWorktree/startCreateWorktree 被 useNewTaskFlow re-export 但无调用方。
 * 保留是为了 follow-up 评估：若 modal 自管路径稳定，应删此文件 + useNewTaskFlow 的 re-export。
 * 使用者：暂无。
 */
import { worktreeApi } from '@/api/domains/worktree'
import { transition, useNewTaskFlowState } from './useNewTaskFlowState'

/** base 分支默认值（D3 决策：origin/main 为默认） */
const DEFAULT_BASE_BRANCH = 'origin/main' as const

/**
 * @param currentCwd 当前 flow 的 cwd（workspaceHint 兜底）
 * @param gitInfo 当前 flow 的 git 派生（不强制依赖，预留守卫扩展点）
 */
export function useNewTaskWorktree(
  currentCwd: () => string | null,
  _gitInfo: () => { branch: string; isRepo: boolean } | null,
): {
  createWorktree: (
    branch: string,
    opts?: { baseBranch?: 'current' | 'origin/main'; workspaceHint?: string },
  ) => Promise<string>
  startCreateWorktree: () => void
} {
  const { pendingCwd } = useNewTaskFlowState()

  /**
   * createWorktree —— 调 worktreeApi.create 在 bare repo 下创建 worktree。
   *
   * 成功：返回新 cwd，记 pendingCwd（chip 回灌所见即所得，统一延迟 create 语义）。
   * 失败：向上抛带 code 的 Error（envelope 透传），由调用方（CreateWorktreeModal）按 code 切态。
   *
   * @returns 新 worktree 的绝对路径（cwd）
   */
  async function createWorktree(
    branch: string,
    opts?: { baseBranch?: 'current' | 'origin/main'; workspaceHint?: string },
  ): Promise<string> {
    const cwd = currentCwd() ?? undefined
    const result = await worktreeApi.create({
      branch,
      baseBranch: opts?.baseBranch ?? DEFAULT_BASE_BRANCH,
      workspaceHint: opts?.workspaceHint ?? cwd,
    })
    pendingCwd.value = result.cwd
    return result.cwd
  }

  /**
   * startCreateWorktree —— 打开 CreateWorktreeModal（landing→worktree-modal）。
   *
   * 与 dirSelect.openWorktreeModal 区别：本方法从 landing 态直接打开（如未来快捷入口），
   * dirSelect 版本从 dir-popover 经归 landing 中转。两者最终态一致（worktree-modal）。
   */
  function startCreateWorktree(): void {
    transition('worktree-modal')
  }

  return {
    createWorktree,
    startCreateWorktree,
  }
}
