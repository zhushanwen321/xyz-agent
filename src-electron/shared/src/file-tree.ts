/**
 * shared/file-tree.ts — FileNode DTO（⑤code-arch §3，#1，D-012）
 *
 * 跨 runtime/前端 共享的纯结构 DTO。**不含 gitStatus**（D-012 树结构与 git 标注分离）。
 * ignored? 标志支持 D-020「显示忽略项开关」（默认隐藏，开关开时由 FileService 填充）。
 *
 * 接线层级：[port] 类型定义（无方法体）。
 * 数据流：runtime FileService.listTree/expandDir 返回 → WS → 前端 fileTreeStore.tree。
 */

/** 文件节点类型 */
export type FileNodeType = 'dir' | 'file'

/**
 * 文件树节点 DTO（D-012：树结构与 git 标注分离，FileNode 不含 gitStatus）。
 * children 仅 dir 有；type 限定 dir/file；ignored 仅 showIgnored=true 时由 FileService 填充（D-020）。
 *
 * 不变式：path 唯一标识；type ∈ dir/file；dir 有 children?（懒加载三态：
 * undefined=未加载，[]=空目录已加载，FileNode[]=已加载），file 有 size?。
 */
export interface FileNode {
  /** 相对于 cwd 的完整路径（如 'src/index.ts'，不含前导斜杠） */
  path: string
  /** 节点名（basename，如 'index.ts'） */
  name: string
  /** 节点类型 */
  type: FileNodeType
  /** 子节点（仅 dir 有，file 为 undefined；懒加载时可能为空数组表示未展开） */
  children?: FileNode[]
  /** 文件大小（字节，仅 file 有意义；dir 可选） */
  size?: number
  /** 是否被 gitignore 忽略（D-020，仅 showIgnored=true 时 FileService 填充，默认不填/undefined） */
  ignored?: boolean
}
