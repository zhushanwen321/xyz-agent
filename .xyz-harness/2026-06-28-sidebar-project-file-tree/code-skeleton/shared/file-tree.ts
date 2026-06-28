/**
 * code-skeleton/shared/file-tree.ts — FileNode DTO（⑤code-arch §3，#1，D-012）
 *
 * 跨 runtime/前端 共享的纯结构 DTO。**不含 gitStatus**（D-012 树/标注分离）。
 * ignored? 标志支持 D-004「显示忽略项开关」（默认隐藏，开关开时返回并前端灰斜体 D-007②）。
 *
 * 接线层级：[port] 类型定义（无方法体）。
 * 数据流：runtime FileService.listTree/expandDir 返回 → WS → 前端 fileTreeStore.tree。
 */

/** 文件节点类型（dir 可有 children?，file 有 size?）。 */
export type FileNodeType = 'dir' | 'file'

/**
 * FileNode — 文件树结构节点（DTO）。
 * 不变式：path 唯一标识；type ∈ dir/file；dir 有 children?（懒加载三态），file 有 size?。
 * ignored? 仅 showIgnored=true 时由 FileService 填充（D-020）。
 */
export interface FileNode {
  path: string
  name: string
  type: FileNodeType
  /** 子节点（仅 dir；懒加载下 undefined=未加载，[]=空目录已加载，FileNode[]=已加载）。 */
  children?: FileNode[]
  /** 文件大小（仅 file）。 */
  size?: number
  /** 被 .gitignore 匹配标志（仅 showIgnored=true 模式返回，D-020）。 */
  ignored?: boolean
}
