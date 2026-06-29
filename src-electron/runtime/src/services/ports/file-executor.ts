/**
 * IFileExecutor port（code-architecture §3，#2 D-008）。
 *
 * 🔒 三层架构：services 定义 port，infra/fs-executor.ts 实现（node:fs/promises）。
 * FileService 经此 port 访问 fs，不直接 import node:fs（AC-2 grep 验证：services 层无 node:fs 引用）。
 *
 * Port 决策（D-008，Local-substitutable）：fs 有内存替身（测试 mock）→ port
 * （2 adapter：FsExecutor 生产 + in-memory 测试 = 真 seam）。
 * 范式与 IGitExecutor（services/ports/git-executor.ts）对称。
 */
/**
 * infra readdir 返回的薄结构，FileService 编排时映射成 FileNode（@xyz-agent/shared）。
 * type 限定 'dir' | 'file'（与 FileNodeType 对齐，此处独立声明避免 port 依赖 shared 类型）。
 */
export interface FsEntry {
  name: string
  type: 'dir' | 'file'
  /** 文件大小（字节，仅 file 有意义；dir entry 可省略，由 FileService 按需取） */
  size?: number
}

/**
 * fs 访问 port。
 *
 * 实现约束（infra/fs-executor.ts）：
 * - listDir **单层 readdir**（不递归，depth=1 编排在 FileService）。
 *   dir entry 不取 size（undefined），file entry 取 size（性能优化，NFR）。
 * - 超时机制（Promise.race，④NFR K-2：node:fs/promises 无内建超时）：超时 reject Error，
 *   FileService catch 后转 FileError('timeout')。
 * - symlink 目录（④NFR K-3）：readdir 对符号链接判 isSymbolicLink()，
 *   遇 ELOOP/EACCES catch 后跳过该 entry（不 follow 成环）。
 * - EACCES → reject Error(code='EACCES')，FileService 转 FileError('permission_denied')。
 */
export interface IFileExecutor {
  /** 列目录单层子（不递归）。超时/EACCES → reject Error。 */
  listDir(path: string): Promise<FsEntry[]>
  /** 取文件/目录 stat。 */
  stat(path: string): Promise<{ type: 'dir' | 'file'; size: number }>
  /** 读文件内容（utf-8）。 */
  readFile(path: string): Promise<string>
}
