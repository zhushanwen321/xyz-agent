/**
 * GitInfo 类型（useNewTaskFlow.gitInfo ComputedRef 元素）。
 * 派生自 SessionSummary.gitBranch：UC-7 chip 可见性 + 状态机守卫（非 git 目录 branch 相关不可达）。
 * - branch=null / isRepo=false → 非 git 目录或 unborn HEAD，branch chip 隐藏（AC-2.2/3.7）
 * - branch 非空 → git 目录，全 8 态可达
 */
export interface GitInfo {
  branch: string | null
  isRepo: boolean
}
