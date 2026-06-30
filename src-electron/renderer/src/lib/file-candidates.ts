/**
 * FileNode → composer `#` 候选项的 DTO 映射（G16）。
 *
 * 背景：file.search 返回 FileNode[]（{path, name, type:'dir'|'file', ...}，name 是 basename
 * 不带斜杠），但 CommandPopover 的 file 分支期望的候选项形状是 mock FILE_CANDIDATES 的
 * {id, name, kind:'目录'|'文件', path?}（中文 kind，目录 name 带尾随斜杠）。两套 DTO 不同构，
 * 直接喂会导致图标判定失效（CommandPopover 用 `f.kind === '目录' ? 'folder' : 'file'`）。
 *
 * 映射规则：
 * - id = path（FileNode.path 相对 cwd，唯一）
 * - name = 目录补尾随斜杠（'src' → 'src/'），文件保持 basename
 * - kind = 中文 '目录' / '文件'（对齐 CommandPopover 图标判定）
 * - path = FileNode.path（透传）
 * - type = FileNode.type（透传，供消费方按需区分）
 */
import type { FileNode } from '@xyz-agent/shared'

/** composer `#` 候选项形状（与 mock FILE_CANDIDATES 同构，CommandPopover 消费） */
export interface FileCandidate {
  id: string
  name: string
  kind: string
  path?: string
  type?: 'dir' | 'file'
}

/**
 * FileNode[] → FileCandidate[] 映射。
 * 目录 name 补尾随斜杠，kind 用中文（对齐 CommandPopover 图标判定逻辑）。
 */
export function toFileCandidates(nodes: FileNode[]): FileCandidate[] {
  return nodes.map((n) => ({
    id: n.path,
    name: n.type === 'dir' ? `${n.name}/` : n.name,
    kind: n.type === 'dir' ? '目录' : '文件',
    path: n.path,
    type: n.type,
  }))
}
