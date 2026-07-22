/**
 * IWorktreeService port —— worktree 创建的领域编排契约（W1）。
 *
 * 🔒 三层架构：services 定义 port，services/worktree/worktree-service.ts 实现。
 * WorktreeMessageHandler 经此 port 调用 create，不直接依赖具体 WorktreeService。
 *
 * 编排职责（实现侧 WorktreeService）：
 * 1. 经 WorkspaceDetector 检测 .bare 结构（isBareMode=false → NOT_BARE_REPO）
 * 2. 经 IGitExecutor 跑 `git worktree add`（白名单含 'worktree'）
 * 3. 经 IShellRunner 跑可选的 `<bare>/custom-hooks/setup-worktree.sh`（npm install / git hooks 等）
 *
 * 错误对象统一用 `Object.assign(new Error(msg), { code, detail })` 模式——
 * 测试用 toMatchObject 断言 code/detail，故错误必须是普通 Error + 附加字段（非 class 实例）。
 * 这与 GitError/FileError 的 class 模式不同，是 WorktreeService 的刻意选择：
 * worktree 错误码（NOT_BARE_REPO / WORKTREE_EXISTS / SETUP_FAILED）只在本域消费，
 * 无需跨层 instanceof 判定，扁平字段更利于测试断言。
 */

/** worktree 创建参数。 */
export interface WorktreeCreateParams {
  /** 新分支名（如 'feat/oauth'）。目录名由其派生（/ → -）。 */
  branch: string
  /** 基分支：'current'（继承当前分支，默认）/ 'origin/main'（校验远端 ref 存在后使用）。 */
  baseBranch?: 'current' | 'origin/main'
  /** workspace 检测起点 cwd（缺省用 process.cwd()）。前端发起时显式传入。 */
  workspaceHint?: string
}

/** worktree 创建结果。 */
export interface WorktreeCreateResult {
  /** 新 worktree 的绝对路径（cwd）。 */
  cwd: string
  /** 新分支名（与入参一致，原始分支名含斜杠）。 */
  branch: string
}

/**
 * worktree 创建 port。
 *
 * 失败模式（实现抛 Object.assign 错误）：
 * - NOT_BARE_REPO：当前 cwd 不在 bare repo + worktree 结构下
 * - WORKTREE_EXISTS：目标 worktree 目录已存在。detail = { cwd, dirName }，
 *   前端可核对 dirName 是否与当前请求分支一致——区分「同分支已存在」与
 *   「另一分支名映射同目录碰撞」（feat/a 与 feat-a 映射同目录）。
 * - GIT_FAILED：git worktree add 失败（exitCode 非 0）
 * - SETUP_FAILED：setup-worktree.sh 失败（exitCode 非 0），detail 含 exitCode + stderr
 */
export interface IWorktreeService {
  create(params: WorktreeCreateParams): Promise<WorktreeCreateResult>
}
