/**
 * code-skeleton/runtime/services/file-service.ts — FileService 编排（⑤code-arch §3，#2/#7/#16，D-008 三层+port）
 *
 * 职责（单一变化轴「文件树编排」）：cwd 解析 / 越界统一守门 / 懒加载分页 / ignore 双模式 / readFile 截断+审计。
 *
 * 数据流（§4 功能1）：listTree → sessionService.getSummary(sid).cwd → isUnderOrEqual 守门 →
 *   executor.listDir ×N（1+M 次，F-1）→ ignore-parser 双模式过滤 → FileNode[]。
 *
 * 接线层级：[L1-接线] 方法体真接下游（this.executor.x / isUnderOrEqual / matchPath）。
 * 可测性：accept deps（executor + sessionService 经构造注入），return results。
 */
import type { IFileExecutor } from './ports/file-executor'
import type { FileNode } from '@shared/file-tree'
import { isUnderOrEqual } from '@shared/path-guard'
import { compileIgnoreRules, matchPath, type IgnoreMatcher } from '@shared/ignore-parser'
import { FileError } from './file-error'

/** FileService 依赖（accept deps，可测性）。 */
export interface FileServiceOptions {
  executor: IFileExecutor
  sessionService: { getSummary(sessionId: string): { cwd: string } | undefined }
}

/** 原 file.read 白名单 3 目录（BC-3 扩展不收紧，#7）。迁自 server.ts:481-486。 */
const SKILL_PREFIXES: string[] = [
  // ~/.agents/skills（全局 skill）/ pi agent skills / pi agent npm —— ⑤骨架由 config 注入实际路径
]

/** readFile 截断阈值（AC-6.7 超大文件截断）。 */
const READ_TRUNCATE_BYTES = 1_000_000

export class FileService {
  constructor(private opts: FileServiceOptions) {}

  /**
   * 文件树首加载（UC-1，#2）。
   * 编排：顶层 listDir(cwd) + 对每个 dir 再 listDir（1+M 次，F-1）→ ignore 双模式过滤。
   * @throws FileError('session_not_found' | 'permission_denied' | 'out_of_cwd')
   */
  async listTree(sessionId: string, showIgnored?: boolean): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId) // L1-接线：sessionService.getSummary
    // 越界守门（NFR-AC-S2 统一守门，cwd 自身恒在子树内，守门为一致性）
    this.guardCwd(cwd, cwd)
    const matcher = await this.loadIgnoreMatcher(cwd) // L1-接线：executor.readFile(.gitignore) + compileIgnoreRules
    const topEntries = await this.opts.executor.listDir(cwd) // L1-接线
    const topNodes = topEntries.map(e => this.toFileNode(cwd, e))
    // depth=1 编排：对顶层 dir 再 listDir 拿一级子（F-1：1+M 次，M=顶层目录数）
    for (const node of topNodes) {
      if (node.type === 'dir' && node.children === undefined) {
        const childEntries = await this.opts.executor.listDir(node.path) // L1-接线
        node.children = childEntries.map(e => this.toFileNode(node.path, e))
      }
    }
    return this.applyIgnoreFilter(topNodes, matcher, showIgnored ?? false) // L1-接线：matchPath 双模式
  }

  /**
   * 展开目录单层子（UC-3，#3）。
   * @throws FileError('out_of_cwd' NFR-AC-S2 | 'timeout' AC-2.5)
   */
  async expandDir(sessionId: string, path: string, showIgnored?: boolean): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId)
    this.guardCwd(cwd, path) // L1-接线：越界统一守门（NFR-AC-S2，expand 也校验）
    const matcher = await this.loadIgnoreMatcher(cwd)
    const entries = await this.opts.executor.listDir(path) // L1-接线
    const nodes = entries.map(e => this.toFileNode(path, e))
    return this.applyIgnoreFilter(nodes, matcher, showIgnored ?? false)
  }

  /**
   * 读文件内容（UC-6 前置，#7 BC-3 下沉）。
   * 越界校验：cwd 外且非原3目录 → out_of_cwd。>1MB 截断（AC-6.7）。审计日志。
   * @throws FileError('out_of_cwd' AC-7.3 | 'read_failed')
   */
  async readFile(sessionId: string, path: string): Promise<{ content: string; truncated: boolean }> {
    const cwd = this.requireCwd(sessionId)
    this.guardReadPath(cwd, path) // L1-接线：cwd 子树 ∪ 原3目录（BC-3 扩展不收紧）
    const content = await this.opts.executor.readFile(path) // L1-接线
    // 截断（AC-6.7）—— 骨架只接调用 + 透传，截断阈值判定⑥Wave 实现
    const truncated = Buffer.byteLength(content) > READ_TRUNCATE_BYTES
    // 审计日志（④NFR：file.read 是敏感操作）—— ⑤骨架约束日志存在性
    this.auditRead(sessionId, path)
    return { content: truncated ? content.slice(0, READ_TRUNCATE_BYTES) : content, truncated }
  }

  // ── file.write.* 骨架（#14，G4 实现延后，AC-14.4 结构化「待实现」）──
  async createFile(_sessionId: string, _path: string, _content?: string): Promise<never> {
    throw new FileError('read_failed', 'not_implemented: file.write.create (G4)') // [叶子] 骨架
  }
  async renameFile(_sessionId: string, _from: string, _to: string): Promise<never> {
    throw new FileError('read_failed', 'not_implemented: file.write.rename (G4)') // [叶子] 骨架
  }
  async deleteFile(_sessionId: string, _path: string): Promise<never> {
    throw new FileError('read_failed', 'not_implemented: file.write.delete (G4)') // [叶子] 骨架
  }

  // ── 私有编排方法（L1-接线）──

  /** 取 session.cwd，session 不存在抛 session_not_found。 */
  private requireCwd(sessionId: string): string {
    const summary = this.opts.sessionService.getSummary(sessionId)
    if (!summary) throw new FileError('session_not_found', sessionId)
    return summary.cwd
  }

  /** 越界守门（NFR-AC-S2 统一守门，listTree/expandDir 用）。 */
  private guardCwd(cwd: string, path: string): void {
    if (!isUnderOrEqual(cwd, path)) throw new FileError('out_of_cwd', path) // L1-接线：shared 纯函数
  }

  /** readFile 越界守门（BC-3：cwd 子树 ∪ 原3目录，扩展不收紧）。 */
  private guardReadPath(cwd: string, path: string): void {
    if (isUnderOrEqual(cwd, path)) return // cwd 子树
    if (SKILL_PREFIXES.some(p => path.startsWith(p + '/'))) return // 原3目录保留（NFR-AC-C1）
    throw new FileError('out_of_cwd', path) // 越界拒绝（AC-7.3）
  }

  /** 读 .gitignore 编译 matcher（IO 走 port，计算走 shared 纯函数）。 */
  private async loadIgnoreMatcher(cwd: string): Promise<IgnoreMatcher> {
    try {
      const content = await this.opts.executor.readFile(cwd + '/.gitignore') // L1-接线
      return compileIgnoreRules(content) // L1-接线：shared 纯函数
    } catch {
      return compileIgnoreRules('') // 无 .gitignore → 空 matcher
    }
  }

  /** ignore 双模式过滤（D-020：默认隐藏 / 显示模式标 ignored=true 保留）。 */
  private applyIgnoreFilter(nodes: FileNode[], matcher: IgnoreMatcher, showIgnored: boolean): FileNode[] {
    return nodes
      .map(node => ({ ...node, ignored: matchPath(matcher, node.path) })) // L1-接线：matchPath
      .filter(node => showIgnored || !node.ignored) // 默认隐藏 ignored；显示模式保留
  }

  /** FsEntry → FileNode 映射。 */
  private toFileNode(parent: string, e: { name: string; type: 'dir' | 'file'; size?: number }): FileNode {
    return {
      path: parent + '/' + e.name,
      name: e.name,
      type: e.type,
      size: e.size,
    }
  }

  /** 审计日志占位（④NFR：sessionId/path/timestamp，⑤骨架约束存在性）。 */
  private auditRead(_sessionId: string, _path: string): void {
    // ⑥Wave 填真实日志（结构化 + traceId）
  }
}
