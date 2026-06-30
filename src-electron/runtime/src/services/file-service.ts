/**
 * FileService —— 文件树编排深模块（code-architecture §3，#2/#7/#16，D-008 三层+port）。
 *
 * 职责（单一变化轴「文件树编排」）：cwd 解析 / 越界统一守门 / 懒加载分层 / ignore 双模式 / readFile 截断。
 *
 * 数据流（§4 功能1）：listTree → sessionService.getSummary(sid).cwd → isUnderOrEqual 守门 →
 *   executor.listDir ×N（1+M 次，F-1：顶层 1 次 + 每个顶层 dir 再 1 次拿一级子）→
 *   ignore-parser 双模式过滤 → FileNode[]（path 相对 cwd，不含前导斜杠）。
 *
 * 分层：FileService 经 IFileExecutor（port）做 IO，经 shared 纯函数（compileIgnoreRules/matchPath）
 *   做 ignore 计算，经 ISessionService 取 cwd。不直接 import node:fs（AC-2 grep 验证）。
 *
 * 安全（NFR-AC-S2 越界统一守门）：
 * - cwd 取自 sessionService.getSummary(sid).cwd（session.create 时确立的受信工作目录）
 * - expandDir/readFile 的 path：path.resolve(cwd, path) 后必须落在 cwd 之下（isUnderOrEqual），
 *   防 `../../etc/passwd` 路径穿越 → 越界抛 FileError('out_of_cwd')。
 *   （listTree 入口对 cwd 自身守门，恒 true，保持入口统一守门模式。）
 */
import { resolve as resolvePath, join, relative } from 'node:path'
import type { FileNode, IgnoreMatcher } from '@xyz-agent/shared'
import { compileIgnoreRules, matchPath } from '@xyz-agent/shared'
import { isUnderOrEqual } from '../utils/path-utils.js'
import type { IFileExecutor, FsEntry } from './ports/file-executor.js'
import type { ISessionService } from '../interfaces.js'
import { FileError } from './file-error.js'

/** FileService 依赖（accept deps，可测性：executor + sessionService 经构造注入）。 */
export interface FileServiceOptions {
  sessionService: ISessionService
  executor: IFileExecutor
  /**
   * file.read 的白名单目录（BC-3，#7）：file.read protocol payload 只有 path 无 sessionId，
   * 无法走 cwd 守门。这些全局白名单目录（~/.agents/skills、piAgentDir/skills、piAgentDir/npm）
   * 允许无 session 读取（skill 文件预览）。装配时（index.ts）从 configService 算出传入。
   */
  allowedReadDirs?: string[]
}

/** 读取超时（ms），listDir/stat/readFile 共用（NFR ④K-2）。导出供测试 advanceTimersByTime 用。 */
export const READ_TIMEOUT_MS = 10_000
/** 文件大小截断阈值（1MB，readFile 用，AC-6.7）。导出供测试断言用。 */
export const MAX_FILE_SIZE = 1_048_576

export class FileService {
  constructor(private opts: FileServiceOptions) {}

  /**
   * 文件树首加载（UC-1，#2，AC-2.1/2.2/2.4，T1.1-1.6）。
   * 编排：顶层 listDir(cwd) + 对每个顶层 dir 再 listDir（1+M 次，F-1）→ ignore 双模式过滤。
   * 顶层 FileNode.path = name（相对 cwd）；dir 的一级子 children.path = name/sub（相对 cwd）。
   * 返回前按 sortNodes 排序（dir 在前、同类型内 name 降序），与 listLevel 一致。
   * @throws FileError('session_not_found' | 'permission_denied' | 'timeout')
   */
  async listTree(sessionId: string, showIgnored?: boolean): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId)
    // 越界守门（NFR-AC-S2 统一守门，cwd 自身恒在子树内，守门为一致性）
    if (!isUnderOrEqual(cwd, cwd)) throw new FileError('out_of_cwd', cwd)
    const matcher = await this.loadMatcher(cwd)
    const topEntries = await this.callFs(() => this.opts.executor.listDir(cwd))
    const showIgn = showIgnored ?? false
    const topNodes: FileNode[] = []
    for (const e of topEntries) {
      const node = this.entryToNode(e, '') // 顶层 relParent='' → path=name
      if (matchPath(matcher, node.path) && !showIgn) continue // 默认隐藏 ignored
      if (matchPath(matcher, node.path)) node.ignored = true // 显示模式：保留并标记
      if (e.type === 'dir') {
        node.children = await this.listLevel(join(cwd, e.name), e.name, matcher, showIgn)
      }
      topNodes.push(node)
    }
    return FileService.sortNodes(topNodes)
  }

  /**
   * 展开目录单层子（UC-3，#3，AC-2.3/2.5，T2.1/T2.10）。
   * @throws FileError('out_of_cwd' | 'session_not_found' | 'permission_denied' | 'timeout')
   */
  async expandDir(sessionId: string, path: string, showIgnored?: boolean): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId)
    const resolvePath_ = resolvePath(cwd, path)
    if (!isUnderOrEqual(cwd, resolvePath_)) throw new FileError('out_of_cwd', path) // 越界统一守门
    const relParent = relative(cwd, resolvePath_) || '' // 相对 cwd 的目录路径（无前导斜杠）
    const matcher = await this.loadMatcher(cwd, resolvePath_)
    return this.listLevel(resolvePath_, relParent, matcher, showIgnored ?? false)
  }

  /**
   * 读文件内容（UC-6 前置，#7，AC-7.1/7.3）。越界守门 + >1MB 截断。
   * W1b 范围：cwd 越界守门 + 读取 + 截断。BC-3 白名单（~/.agents/skills 等）W2 补。
   * @throws FileError('out_of_cwd' | 'not_found' | 'permission_denied' | 'timeout' | 'read_failed')
   */
  async readFile(sessionId: string, path: string): Promise<{ content: string; truncated: boolean }> {
    const cwd = this.requireCwd(sessionId)
    const resolvePath_ = resolvePath(cwd, path)
    if (!isUnderOrEqual(cwd, resolvePath_)) throw new FileError('out_of_cwd', path)
    const statResult = await this.callFs(() => this.opts.executor.stat(resolvePath_))
    const full = await this.callFs(() => this.opts.executor.readFile(resolvePath_))
    if (statResult.size > MAX_FILE_SIZE) {
      return { content: full.slice(0, MAX_FILE_SIZE), truncated: true }
    }
    return { content: full, truncated: false }
  }

  /**
   * 从白名单目录读文件（BC-3，#7，T6.11）。file.read protocol payload 只有 path 无 sessionId，
   * 无法走 cwd 守门，改走 allowedReadDirs 全局白名单（~/.agents/skills 等 skill 目录）。
   *
   * 原 server.ts handleFileRead 内联逻辑下沉至此（解三层违纪 AC-2b）。白名单目录由装配时传入。
   * @throws FileError('out_of_cwd' | 'not_found' | 'permission_denied' | 'timeout' | 'read_failed')
   */
  async readFileFromWhitelist(path: string): Promise<{ content: string; truncated: boolean }> {
    const allowed = this.opts.allowedReadDirs ?? []
    const absPath = resolvePath(path)
    // 白名单守门（与旧 server.ts handleFileRead 一致：absPath 必须在某白名单目录之下）
    if (!allowed.some((dir) => isUnderOrEqual(dir, absPath))) {
      throw new FileError('out_of_cwd', `路径不在允许的 skill 目录内: ${path}`)
    }
    const statResult = await this.callFs(() => this.opts.executor.stat(absPath))
    const full = await this.callFs(() => this.opts.executor.readFile(absPath))
    if (statResult.size > MAX_FILE_SIZE) {
      return { content: full.slice(0, MAX_FILE_SIZE), truncated: true }
    }
    return { content: full, truncated: false }
  }

  // ── file.write 骨架（#14，AC-14.2/14.4，G4 实现延后）──
  // 直接抛 FileError('not_implemented')；handler（W1b-handler）catch 后转结构化响应 { implemented:false }。

  async createFile(_sessionId: string, _path: string, _content: string): Promise<never> {
    throw new FileError('not_implemented', 'file.write not implemented in this release')
  }

  async renameFile(_sessionId: string, _oldPath: string, _newPath: string): Promise<never> {
    throw new FileError('not_implemented', 'file.write not implemented in this release')
  }

  async deleteFile(_sessionId: string, _path: string): Promise<never> {
    throw new FileError('not_implemented', 'file.write not implemented in this release')
  }

  // ── 私有编排方法 ──

  /** 取 cwd；空（session 不存在）→ session_not_found。 */
  private requireCwd(sessionId: string): string {
    const summary = this.opts.sessionService.getSummary(sessionId)
    const cwd = summary?.cwd ?? ''
    if (!cwd) throw new FileError('session_not_found', `Session 不存在或无 cwd: ${sessionId}`)
    return cwd
  }

  /**
   * 列单层并映射 FileNode（ignore 双模式过滤，D-020）。
   * 返回前按 sortNodes 排序（dir 在前、同类型内 name 降序）。
   * @param absPath  目录绝对路径（executor.listDir 用）
   * @param relParent 相对 cwd 的目录路径（FileNode.path 前缀，顶层为 ''）
   */
  private async listLevel(
    absPath: string,
    relParent: string,
    matcher: IgnoreMatcher,
    showIgnored: boolean,
  ): Promise<FileNode[]> {
    const entries = await this.callFs(() => this.opts.executor.listDir(absPath))
    const nodes: FileNode[] = []
    for (const e of entries) {
      const node = this.entryToNode(e, relParent)
      const ignored = matchPath(matcher, node.path)
      if (ignored && !showIgnored) continue // 默认隐藏 ignored
      if (ignored) node.ignored = true // 显示模式：保留并标记
      nodes.push(node)
    }
    return FileService.sortNodes(nodes)
  }

  /**
   * 文件节点排序（展示偏好，单一权威源）：目录在前，同类型内按 name 字典序降序。
   * 用原生 < / > 比较（非 localeCompare）：跨平台/ICU 数据一致、可预测，不依赖运行环境 locale。
   * 静态方法：listTree（顶层）与 listLevel（子层）共用，确保全树一致有序。
   */
  private static sortNodes(nodes: FileNode[]): FileNode[] {
    return nodes.sort((a, b) => {
      // dir 排在 file 前（type 权重：dir=0, file=1）
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      // 同类型内按 name 字典序降序（b 在前 = 降序）
      return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
    })
  }

  /** FsEntry → FileNode 映射。path = relParent ? `${relParent}/${name}` : name（相对 cwd，无前导斜杠）。 */
  private entryToNode(e: FsEntry, relParent: string): FileNode {
    const node: FileNode = {
      path: relParent ? `${relParent}/${e.name}` : e.name,
      name: e.name,
      type: e.type,
    }
    if (e.size !== undefined) node.size = e.size
    return node
  }

  /**
   * 读一组目录的 .gitignore 合并编译 matcher（IO 走 port，计算走 shared 纯函数）。
   * 任一目录无 .gitignore / 读取失败 → 该目录贡献空（不影响其它）。
   */
  private async loadMatcher(...dirs: string[]): Promise<IgnoreMatcher> {
    const contents: string[] = []
    for (const d of dirs) {
      const c = await this.readIgnoreSafe(d)
      if (c) contents.push(c)
    }
    return compileIgnoreRules(contents.join('\n'))
  }

  /** 读 dir/.gitignore，失败/不存在 → ''（不抛）。 */
  private async readIgnoreSafe(dir: string): Promise<string> {
    try {
      return await this.opts.executor.readFile(`${dir}/.gitignore`)
    } catch {
      return ''
    }
  }

  /**
   * 执行一次 executor 调用：超时包装（NFR ④K-2）+ 错误分类（EACCES/ENOENT → FileError）。
   * - 超时 → FileError('timeout')（withTimeout 已抛）
   * - EACCES/EPERM → FileError('permission_denied')
   * - ENOENT → FileError('not_found')
   * - 其余（含已分类的 FileError）→ 透传
   */
  private async callFs<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await this.withTimeout(op)
    } catch (e) {
      const code = (e as { code?: string } | null)?.code
      if (code === 'EACCES' || code === 'EPERM') throw new FileError('permission_denied')
      if (code === 'ENOENT') throw new FileError('not_found')
      throw e // FileError('timeout') 或未知错误透传
    }
  }

  /**
   * 超时包装（NFR ④K-2）：op() 与定时器赛跑，超时 → reject FileError('timeout')。
   *
   * 实现用单 Promise 构造器 + 手动 settle（非 Promise.race）：定时器回调直接调外层 reject，
   * 不产生被 reject 的中间 timeout promise —— 避免「落败 promise 异步 reject 触发
   * unhandledRejection」的竞态（Promise.race + setTimeout 超时模式的已知坑）。
   * op() 的 resolve/reject 在外层 settle 后已 clearTimeout，无悬挂 promise。
   */
  private withTimeout<T>(op: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new FileError('timeout'))
      }, READ_TIMEOUT_MS)
      op().then(
        (v) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }
}
