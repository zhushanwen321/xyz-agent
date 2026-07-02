/**
 * FileService —— 文件树编排深模块（code-architecture §3，#2/#7/#16，D-008 三层+port）。
 *
 * 职责（单一变化轴「文件树编排」）：cwd 解析 / 越界统一守门 / 懒加载分层 / ignore 标记 / readFile 截断。
 *
 * 数据流（§4 功能1）：listTree → sessionService.getSummary(sid).cwd → isUnderOrEqual 守门 →
 *   executor.listDir ×N（1+M 次，F-1：顶层 1 次 + 每个顶层 dir 再 1 次拿一级子）→
 *   ignore-parser 标记（命中的节点标 ignored=true，前端按开关过滤）→ FileNode[]（path 相对 cwd，不含前导斜杠）。
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
import type { ISessionService, IFileService } from '../interfaces.js'
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
/**
 * searchFiles 递归深度上限（根 cwd=depth 0，顶层 entry=depth 1，... 第 8 层 entry 返回但不展开子）。
 * 防深层嵌套目录树无下限耗时；导出供测试断言用。
 */
export const MAX_SEARCH_DEPTH = 8
/**
 * searchFiles DoS 防护上限（达上限停止收集，横向截断）。
 *
 * 设计定位：安全兜底，非功能限制——正常项目（通常 <5000 文件）不触发，
 * 全量返回供前端缓存 + 本地过滤（composer # 候选按 query 即时过滤 name+path）。
 * 仅防未 ignore 的超大批量目录（如 vendor / monorepo 产物）无上限耗时。
 *
 * 500→5000 调整背景：原 500 截断导致深度优先遍历中靠后位置的文件丢失
 * （如根目录的 AGENTS.md），前端在已截断子集上过滤永远筛不到。5000 覆盖
 * 正常项目全量，前端能找到任意文件；超大项目（>5000）仍截断作 DoS 兜底。
 */
export const MAX_SEARCH_RESULTS = 5000
/**
 * searchFiles 内建 ignore 目录名（安全兜底，独立于 .gitignore，不可被 `!` 取反覆盖）。
 * 常见依赖产物/构建/缓存目录，几乎不应出现在 composer 文件候选里。
 */
export const BUILTIN_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache', '.turbo',
])

export class FileService implements IFileService {
  constructor(private opts: FileServiceOptions) {}

  /**
   * 文件树首加载（UC-1，#2，AC-2.1/2.2/2.4，T1.1-1.6）。
   * 编排：顶层 listDir(cwd) + 对每个顶层 dir 再 listDir（1+M 次，F-1）→ ignore 标记。
   * 顶层 FileNode.path = name（相对 cwd）；dir 的一级子 children.path = name/sub（相对 cwd）。
   * 返回前按 sortNodes 排序（dir 在前、同类型内 name 降序），与 listLevel 一致。
   *
   * ignore 策略：始终返回所有节点，对 .gitignore 命中的节点标记 `ignored=true`，
   * 由前端按 showIgnored 开关做本地 computed 过滤（瞬时切换不重拉，避免闪烁）。
   * @throws FileError('session_not_found' | 'permission_denied' | 'timeout')
   */
  async listTree(sessionId: string): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId)
    // 越界守门（NFR-AC-S2 统一守门，cwd 自身恒在子树内，守门为一致性）
    if (!isUnderOrEqual(cwd, cwd)) throw new FileError('out_of_cwd', cwd)
    const matcher = await this.loadMatcher(cwd)
    const topEntries = await this.callFs(() => this.opts.executor.listDir(cwd))
    const topNodes: FileNode[] = []
    for (const e of topEntries) {
      const node = this.entryToNode(e, '') // 顶层 relParent='' → path=name
      if (matchPath(matcher, node.path)) node.ignored = true // 标记 ignored，前端按开关过滤
      if (e.type === 'dir') {
        node.children = await this.listLevel(join(cwd, e.name), e.name, matcher)
      }
      topNodes.push(node)
    }
    return FileService.sortNodes(topNodes)
  }

  /**
   * 展开目录单层子（UC-3，#3，AC-2.3/2.5，T2.1/T2.10）。
   * 同 listTree 的 ignore 策略：始终返回所有节点并标记 ignored=true。
   * @throws FileError('out_of_cwd' | 'session_not_found' | 'permission_denied' | 'timeout')
   */
  async expandDir(sessionId: string, path: string): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId)
    const resolvePath_ = resolvePath(cwd, path)
    if (!isUnderOrEqual(cwd, resolvePath_)) throw new FileError('out_of_cwd', path) // 越界统一守门
    const relParent = relative(cwd, resolvePath_) || '' // 相对 cwd 的目录路径（无前导斜杠）
    const matcher = await this.loadMatcher(cwd, resolvePath_)
    return this.listLevel(resolvePath_, relParent, matcher)
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

  /**
   * composer `#` 文件候选：全量递归当前 cwd（受 ignore + 深度上限 + 结果数上限）。
   *
   * 与 listTree 的关键差异（全量递归场景的安全要求）：
   * - **全量递归**（listTree 仅 2 层），深度上限 `MAX_SEARCH_DEPTH`（根 cwd=depth 0）
   * - **per-directory try/catch 容错**：单子目录 EACCES/ENOENT 跳过继续，不中断整体
   *   （listTree 抛错即终止——对全量递归不可接受，大仓库几乎必有无权目录）
   * - **内建 ignore 独立短路**：BUILTIN_IGNORE_DIRS（node_modules 等）命中即跳过，
   *   不走 matchPath，不可被 .gitignore `!` 取反覆盖（安全兜底，与 matchPath 两道独立关卡）
   * - **matchPath 剪枝**：.gitignore 命中的目录不下钻（showIgnored=false）；showIgnored=true
   *   时标记但**仍不递归**（避免 node_modules 等爆量，composer 场景永远不传 true）
   * - **结果数上限**：收集到 MAX_SEARCH_RESULTS 即停止（横向截断，防超大批量目录耗时）
   * - **symlink 防环**：由 executor 层保证（Dirent.isDirectory() 不 follow symlink），
   *   深度上限 8 作递归硬限制兜底
   *
   * 返回扁平 FileNode[]（非嵌套树，给候选列表用）。排序同 sortNodes（dir 在前 + name 降序）。
   * @throws FileError('session_not_found') —— 仅 session 不存在抛（其余 fs 错误 per-dir 容错）
   */
  async searchFiles(sessionId: string, showIgnored?: boolean): Promise<FileNode[]> {
    const cwd = this.requireCwd(sessionId)
    const matcher = await this.loadMatcher(cwd)
    const showIgn = showIgnored ?? false
    const result: FileNode[] = []

    /**
     * 递归单层（depth-limited + per-dir 容错）。
     * @param absPath  目录绝对路径
     * @param relParent 相对 cwd 的目录路径（顶层 ''）
     * @param depth 当前深度（cwd=0，顶层 entry=1...）
     */
    const walk = async (absPath: string, relParent: string, depth: number): Promise<void> => {
      // 结果数上限：达上限即停止（横向截断）
      if (result.length >= MAX_SEARCH_RESULTS) return

      let entries: FsEntry[]
      try {
        entries = await this.callFs(() => this.opts.executor.listDir(absPath))
      } catch {
        // per-directory 容错：单目录 EACCES/ENOENT/timeout 跳过，不中断整体递归
        return
      }

      for (const e of entries) {
        if (result.length >= MAX_SEARCH_RESULTS) return
        const node = this.entryToNode(e, relParent)

        // 关卡 1：内建 ignore 独立短路（node_modules 等，不可被 .gitignore ! 覆盖）
        if (BUILTIN_IGNORE_DIRS.has(e.name)) continue

        // 关卡 2：.gitignore matchPath 判定
        const ignored = matchPath(matcher, node.path)
        if (ignored && !showIgn) continue // 默认隐藏：跳过不下钻
        if (ignored) node.ignored = true // 显示模式：标记但下面仍不递归（防爆量）

        result.push(node)

        // 目录：深度未达上限才下钻
        if (e.type === 'dir' && depth < MAX_SEARCH_DEPTH) {
          await walk(join(absPath, e.name), node.path, depth + 1)
        }
      }
    }

    await walk(cwd, '', 1)
    return FileService.sortNodes(result)
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
   * 列单层并映射 FileNode（ignore 标记）。
   * 始终返回所有节点，对 .gitignore 命中的节点标记 ignored=true（前端按 showIgnored 开关过滤）。
   * 返回前按 sortNodes 排序（dir 在前、同类型内 name 降序）。
   * @param absPath  目录绝对路径（executor.listDir 用）
   * @param relParent 相对 cwd 的目录路径（FileNode.path 前缀，顶层为 ''）
   */
  private async listLevel(
    absPath: string,
    relParent: string,
    matcher: IgnoreMatcher,
  ): Promise<FileNode[]> {
    const entries = await this.callFs(() => this.opts.executor.listDir(absPath))
    const nodes: FileNode[] = []
    for (const e of entries) {
      const node = this.entryToNode(e, relParent)
      if (matchPath(matcher, node.path)) node.ignored = true // 标记 ignored，前端按开关过滤
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
