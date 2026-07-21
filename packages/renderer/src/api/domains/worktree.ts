/**
 * worktree 域 —— worktree.create RPC 封装（W2 wave）。
 *
 * 数据流：renderer CreateWorktreeModal → worktreeApi.create → command('worktree.create') →
 * runtime WorktreeMessageHandler → WorktreeService.create → git worktree add + setup-worktree.sh。
 *
 * 错误契约：runtime 失败经统一 error envelope reject，错误对象带 code 字段
 * （NOT_BARE_REPO / WORKTREE_EXISTS / SETUP_FAILED / GIT_FAILED）+ detail（exitCode/stderr 等）。
 * 前端 catch 拿到的就是带 code 的 Error（envelope 透传，见 request.ts 的 error 通道）。
 *
 * 依赖方向：api/request（command）+ shared（协议类型 ReplyPayloadMap）。
 */
import { command } from '../request'

/** worktree.create 入参（对齐 ClientMessageMap['worktree.create']） */
export interface WorktreeCreateParams {
  /** 新分支名（如 'feat/oauth'）。目录名由 runtime 派生（/ → -）。 */
  branch: string
  /** 基分支：current（继承当前分支）/ origin/main（校验远端 ref 存在后使用） */
  baseBranch?: 'current' | 'origin/main'
  /** workspace 检测起点 cwd（缺省用 process.cwd()）。前端发起时显式传入 */
  workspaceHint?: string
}

/** worktree.create 成功 reply（对齐 ServerMessageMap['worktree.created']） */
export interface WorktreeCreateReply {
  /** 新 worktree 的绝对路径（cwd） */
  cwd: string
  /** 新分支名（与入参一致，原始分支名含斜杠） */
  branch: string
}

/**
 * worktree 域 API。
 *
 * create 调用 runtime 在 bare repo + worktree 结构中创建隔离的工作目录：
 * - 成功 → resolve { cwd, branch }
 * - 失败 → reject 带 code 的 Error（SETUP_FAILED / WORKTREE_EXISTS / NOT_BARE_REPO / GIT_FAILED）
 *   前端按 code 切换到 error / exists 态。
 */
export const worktreeApi = {
  async create(params: WorktreeCreateParams): Promise<WorktreeCreateReply> {
    // command 的泛型 K 由 type 字面量 'worktree.create' 推导，reply 类型由 ReplyPayloadMap['worktree.create']
    // 推导为 { cwd: string; branch: string }（与 WorktreeCreateReply 结构一致）。不显式传 K 避免约束冲突。
    return command('worktree.create', params)
  },
}
