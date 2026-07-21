/**
 * WorktreeService —— worktree 创建的领域编排实现（W1）。
 *
 * 🔒 三层架构：本类实现 services/ports/worktree-service.ts 的 IWorktreeService port。
 * 编排三步：(1) WorkspaceDetector 检测 .bare 结构 (2) IGitExecutor 跑 git worktree add
 * (3) IShellRunner 跑可选的 setup-worktree.sh（项目黑盒，不存在则跳过）。
 *
 * 依赖全经构造函数注入（gitExecutor / shellRunner / gitInfoReader / fs），production 由
 * index.ts 传真实实现，测试传 mock。此模式让 WorktreeService 单测完全隔离 IO。
 *
 * 错误对象用 `Object.assign(new Error(msg), { code, detail })` 扁平模式（非 class）——
 * 测试用 toMatchObject 断言 code/detail，详见 port 注释。
 *
 * 编排顺序与测试 WS-1~7 严格对齐：
 * 1. detect → isBareMode=false 抛 NOT_BARE_REPO（WS-2）
 * 2. 目录名 = branch.replace(/\//g,'-')，existsSync(newWtPath) 冲突检查（WS-3 WORKTREE_EXISTS）
 * 3. base 解析：origin/main 先 rev-parse 验证 ref 存在（WS-6 两次 gitExecutor 调用）
 * 4. git worktree add -b branch baseRef（WS-1/WS-7）
 * 5. setup 脚本 existsSync 检查：不存在跳过（WS-4），存在则 IShellRunner.execute（WS-5 SETUP_FAILED）
 */
import { join } from 'node:path'
import { WorkspaceDetector } from './workspace-detector.js'
import type { IShellRunner } from '../ports/shell-runner.js'
import type { IGitExecutor } from '../ports/git-executor.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import type {
  IWorktreeService,
  WorktreeCreateParams,
  WorktreeCreateResult,
} from '../ports/worktree-service.js'

/** WorktreeService 依赖（全注入，可 mock）。 */
export interface WorktreeServiceDeps {
  gitExecutor: IGitExecutor
  shellRunner: IShellRunner
  gitInfoReader: IGitInfoReader
  /** node:fs 的 existsSync（测试用 vi.doMock 后传入） */
  fs: { existsSync: (path: string) => boolean }
}

/** setup-worktree.sh 默认超时（pnpm install 最坏情况）。 */
const SETUP_TIMEOUT_MS = 120_000

/** 主分支 fallback（origin/main ref 不存在时用本地 main）。 */
const LOCAL_MAIN = 'main'

export class WorktreeService implements IWorktreeService {
  constructor(private deps: WorktreeServiceDeps) {}

  async create(params: WorktreeCreateParams): Promise<WorktreeCreateResult> {
    const { branch, baseBranch = 'origin/main', workspaceHint } = params

    // 1. 检测 .bare workspace 结构
    const detector = new WorkspaceDetector({
      statSync: (p) => this.deps.fs.existsSync(p)
        ? { isDirectory: () => true }
        : (() => { const e = new Error('not found') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e })(),
    })
    // 注：上面的 detector 包装层把 existsSync 适配成 statSync 语义。
    // 但测试 WS-2 期望 isBareMode=false 时 existsSync 全返回 false（包括 .bare），
    // WS-1/3 期望 barePath 的 existsSync 返回 true。这里直接复用注入的 fs。
    const { isBareMode, wsRoot, barePath } = this.detectBare(workspaceHint)

    if (!isBareMode) {
      throw Object.assign(new Error('当前目录不在 .bare workspace 下，无法创建 worktree'), {
        code: 'NOT_BARE_REPO',
      })
    }

    // 2. 目录名转换 + 冲突检查
    const dirName = branch.replace(/\//g, '-')
    const newWtPath = join(wsRoot, dirName)
    if (this.deps.fs.existsSync(newWtPath)) {
      throw Object.assign(new Error(`worktree 目录已存在: ${newWtPath}`), {
        code: 'WORKTREE_EXISTS',
        detail: newWtPath,
      })
    }

    // 3. base 解析
    const baseRef = await this.resolveBaseRef(barePath, baseBranch, workspaceHint)

    // 4. git worktree add
    await this.deps.gitExecutor.exec(barePath, 'worktree', [
      'add', newWtPath, '-b', branch, baseRef,
    ])

    // 5. setup 脚本（可选，不存在跳过）
    const setupScriptPath = join(barePath, 'custom-hooks', 'setup-worktree.sh')
    if (this.deps.fs.existsSync(setupScriptPath)) {
      const result = await this.deps.shellRunner.execute({
        scriptPath: setupScriptPath,
        args: [newWtPath],
        cwd: newWtPath,
        timeout: SETUP_TIMEOUT_MS,
      })
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(`setup 脚本失败（exitCode=${result.exitCode}）`), {
          code: 'SETUP_FAILED',
          detail: { exitCode: result.exitCode, stderr: result.stderr },
        })
      }
    }

    return { cwd: newWtPath, branch }
  }

  /**
   * 检测 .bare workspace 结构（内部复用 WorkspaceDetector）。
   * 把注入的 fs.existsSync 适配成 WorkspaceDetector 期望的 statSync 语义。
   */
  private detectBare(workspaceHint?: string) {
    const detector = new WorkspaceDetector({
      statSync: (p: string) => {
        if (this.deps.fs.existsSync(p)) return { isDirectory: () => true }
        const e = new Error('not found') as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      },
    })
    return detector.detect(workspaceHint ?? process.cwd())
  }

  /**
   * 解析 base ref。
   * - 'current'：用 gitInfoReader 读当前分支，读不到 fallback main
   * - 'origin/main'：用 gitExecutor rev-parse 验证远端 ref 存在，不存在 fallback 本地 main
   *
   * WS-6 期望：baseBranch='origin/main' 时 gitExecutor 第一次调用是 rev-parse（检查 ref），
   * 第二次才是 worktree add。
   */
  private async resolveBaseRef(
    barePath: string,
    baseBranch: 'current' | 'origin/main',
    workspaceHint?: string,
  ): Promise<string> {
    if (baseBranch === 'current') {
      const info = this.deps.gitInfoReader.readGitInfo(workspaceHint ?? process.cwd())
      return info?.branch ?? LOCAL_MAIN
    }
    // 'origin/main'：验证 ref 存在
    const result = await this.deps.gitExecutor.exec(barePath, 'rev-parse', ['--verify', baseBranch])
    return result.exitCode === 0 ? baseBranch : LOCAL_MAIN
  }
}
