/**
 * Mock git domain —— 与 @/api/domains/git 同接口签名（Wave 1a 创建 real 侧后由 api/index 接线）。
 *
 * 依据：issues.md #4 方案 A + code-architecture.md §6.3 点4 + spec-w11.md FR-12/G-R2-07。
 * 返回固定 GitStatusResult fixture（覆盖 GitZone 四态：clean/staged/dirty/conflict 的数据源），
 * 让 GitZone 在 mock 模式下可验证渲染，无需真实 git 仓库。
 *
 * 依赖方向：仅依赖 shared 类型 + mock TIMING/sleep（与 mock/index.ts 同构）。不 import transport。
 */
import type { GitStatusResult } from '@xyz-agent/shared'

/** 流式时序（ms）—— 与 mock/index.ts TIMING 对齐，保持 mock 节奏一致 */
const TIMING = {
  ack: 40,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 固定 GitStatusResult fixture（覆盖 GitFileStatus 全部 status 枚举 + GitZone 四态）。
 *
 * files 设计（xyCode 双列：X=staged，Y=unstaged）：
 * - 'A '  staged add        → 计入 stagedCount
 * - 'M '  staged modified   → 计入 stagedCount
 * - ' M'  unstaged modified → 计入 unstagedCount
 * - ' D'  unstaged delete   → 计入 unstagedCount
 * - 'UU'  both modified     → unmerged（冲突，hasConflict=true）
 * - 'R '  staged rename     → 计入 stagedCount
 * - '??'  untracked         → 计入 unstagedCount
 *
 * 派生：stagedCount=3（A /M /R ），unstagedCount=3（ M/ D/??），hasConflict=true（UU）。
 * stats 为 git diff --numstat 聚合（+42/-7）。
 */
export const fixtureGitStatus: GitStatusResult = {
  sessionId: '',
  isRepo: true,
  branch: 'main',
  stagedCount: 3,
  unstagedCount: 3,
  stats: { add: 42, del: 7 },
  hasConflict: true,
  files: [
    { path: 'src/new-feature.ts', xyCode: 'A ', status: 'added' },
    { path: 'src/existing.ts', xyCode: 'M ', status: 'modified' },
    { path: 'src/dirty.ts', xyCode: ' M', status: 'modified' },
    { path: 'src/old-file.ts', xyCode: ' D', status: 'deleted' },
    { path: 'src/conflict.ts', xyCode: 'UU', status: 'unmerged' },
    { path: 'README.md', xyCode: 'R ', status: 'renamed' },
    { path: 'untracked.log', xyCode: '??', status: 'untracked' },
  ],
}

/**
 * Mock git domain。status 返回 fixture 深拷贝（注入 sessionId）；
 * stage/unstage/commit 仅 ack（mock 不模拟真实 git 写操作，D7 不模拟失败）。
 *
 * Wave 1a 创建 api/domains/git.ts（real）后，api/index.ts 加：
 *   export const git = isMock ? mockApi.git : realGit
 */
export const git = {
  async status(sessionId: string): Promise<GitStatusResult> {
    await sleep(TIMING.ack)
    return { ...fixtureGitStatus, sessionId, files: fixtureGitStatus.files.map((f) => ({ ...f })) }
  },
  async stage(_sessionId: string, _filePaths?: string[]): Promise<void> {
    await sleep(TIMING.ack)
  },
  async unstage(_sessionId: string, _filePaths?: string[]): Promise<void> {
    await sleep(TIMING.ack)
  },
  async commit(_sessionId: string, _message?: string): Promise<void> {
    await sleep(TIMING.ack)
  },
  // 与 real api/domains/git.ts 同构：切换分支（#6）。mock 仅 ack，不模拟真实 checkout/dirty 冲突
  async checkout(_sessionId: string, _name: string): Promise<void> {
    await sleep(TIMING.ack)
  },
}
