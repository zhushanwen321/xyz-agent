/**
 * code-skeleton/runtime/services/git-service-extension.ts — GitService.getFileDiff 扩展（⑤code-arch §3，#5）
 *
 * 📌 骨架只验 getFileDiff 签名 + 调用链（经 IGitExecutor port，K-6 新增越界校验）。
 * 现有 GitService（git-service.ts:63）已有 getStatus/getCwd/resolveFilePaths，本文件是 getFileDiff 的独立验证。
 * ⑥Wave 合并进 git-service.ts 时按此契约。
 *
 * 数据流（§4 功能3 git.diff 分轨）：getFileDiff → getCwd → 新写越界校验（K-6，仿 resolveFilePaths）
 *   → executor.exec(cwd, 'diff', ['--', path])（NFR-AC-S3 经 port execFileSync 数组形式）。
 *
 * 接线层级：[L1-接线] 真接 executor.exec + isUnderOrEqual。
 *
 * ⚠️ K-6：git-service.ts 现有 resolveFilePaths（L75-87）只用于 stage/unstage/commit 写操作，
 *    diff 路径无先例。getFileDiff 需**新写**越界校验（非复用）。
 * ⚠️ K-7：git-info.ts:59 execSync 字符串拼接绕 port（既有技术债）—— grep 门禁口径由 ⑥Wave 定
 *    （收编 port 或显式豁免+论证）。
 */
import { resolve } from 'node:path'
import { isUnderOrEqual } from '@shared/path-guard'

/** IGitExecutor port（实证 services/ports/git-executor.ts，白名单已含 'diff'）。 */
export interface IGitExecutorLike {
  exec(cwd: string, command: 'diff' | string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/** GitError（实证 git-service.ts:29-36）。 */
export class GitError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'GitError'
  }
}

/** getFileDiff 依赖。 */
export interface GitServiceOptions {
  executor: IGitExecutorLike
  sessionService: { getSummary(sessionId: string): { cwd: string } | undefined }
}

/** getFileDiff 扩展（#5）。⑥Wave 合并进 GitService class。 */
export class GitServiceFileDiffExtension {
  constructor(private opts: GitServiceOptions) {}

  async getFileDiff(sessionId: string, path: string): Promise<{ patch: string; binary: boolean }> {
    const cwd = this.opts.sessionService.getSummary(sessionId)?.cwd
    if (!cwd) throw new GitError('session_not_found', sessionId)
    // K-6：新写越界校验（仿 resolveFilePaths，diff 路径无先例）
    const absPath = resolve(cwd, path)
    if (!isUnderOrEqual(cwd, absPath)) throw new GitError('path_not_allowed', path) // L1-接线：NFR-AC-S5
    // NFR-AC-S3：经 port execFileSync 数组形式（禁函数体直接 exec/execSync）
    const result = await this.opts.executor.exec(cwd, 'diff', ['--', path]) // L1-接线：经 port
    if (result.exitCode !== 0) {
      // 非 git 仓库 / 路径无效 → 空 patch 或结构化 error（AC-5.3）
      // 二进制 → result.stdout 含 "Binary files differ"（AC-5.5/6.8）
      const binary = result.stdout.includes('Binary files differ')
      return { patch: result.stdout, binary }
    }
    return { patch: result.stdout, binary: false }
  }
}
