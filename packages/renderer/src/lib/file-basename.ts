/**
 * 文件路径/basename 反查工具（裸文件名 + 含/路径识别配套）。
 *
 * 用途：markdown 路径识别白名单（design.md 裸 basename、src/foo.ts 含/路径）
 * → 点击时按 basename/path 反查完整 FileNode。
 * 数据源：fileSearchStore 的全量递归 file.search 结果（FileNode[]，扁平 path 列表）。
 *
 * - findByBasename：收集指定 basename 的所有匹配（多匹配触发歧义选择浮层）
 * - collectBasenames：扁平化为 basename Set，供 markdown env.localFiles 用
 * - collectFilePaths：扁平化为 path Set，供 markdown env.filePaths 用（含/路径识别白名单）
 */
import type { FileNode } from '@xyz-agent/shared'

/**
 * 从全量 FileNode[] 收集指定 basename 的所有匹配（type==='file'）。
 *
 * 多匹配场景（src/a.ts + lib/a.ts）由调用方决定如何处理（弹选择浮层）。
 * fileSearchStore 的 FileNode[] 是扁平的（file.search 返回），无需递归 children。
 *
 * @param nodes fileSearchStore 的全量文件列表
 * @param basename 文件名（如 'design.md'，无路径前缀）
 * @returns 所有 name === basename 的 file 节点（可能 0/1/N 个）
 */
export function findByBasename(nodes: FileNode[], basename: string): FileNode[] {
  return nodes.filter((n) => n.type === 'file' && n.name === basename)
}

/**
 * 扁平化 FileNode[] 为 basename Set，供 markdown env.localFiles 用。
 *
 * 递归遍历 children（fileSearchStore 实际返回扁平列表，递归以防万一未来数据结构变化）。
 * 只收集 type==='file' 的 name（目录 name 不进集合，避免误识别目录名）。
 *
 * @param nodes fileSearchStore 的全量文件列表（可能含嵌套 children）
 * @returns basename 集合（如 {'design.md', 'README.md', 'index.ts', ...}）
 */
export function collectBasenames(nodes: FileNode[]): Set<string> {
  const set = new Set<string>()
  const walk = (ns: FileNode[]): void => {
    for (const n of ns) {
      if (n.type === 'file') set.add(n.name)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return set
}

/**
 * 扁平化 FileNode[] 为 path Set，供 markdown env.filePaths 用（含/路径识别白名单）。
 *
 * 与 collectBasenames 对称，区别在于收集 FileNode.path（相对 cwd 的完整路径，如 'src/index.ts'）
 * 而非 FileNode.name（basename）。正文裸路径（如 src/foo.ts）必须命中此集合才链接化。
 *
 * 路径形态：相对 cwd、无前导 /，与正文裸路径写法一致（FileNode.path 规范，见 file-tree.ts）。
 * 只收集 type==='file' 的 path（目录 path 不进集合，避免误识别目录名）。
 *
 * @param nodes fileSearchStore 的全量文件列表（可能含嵌套 children）
 * @returns path 集合（如 {'src/index.ts', 'packages/x.ts', 'README.md', ...}）
 */
export function collectFilePaths(nodes: FileNode[]): Set<string> {
  const set = new Set<string>()
  const walk = (ns: FileNode[]): void => {
    for (const n of ns) {
      if (n.type === 'file') set.add(n.path)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return set
}
