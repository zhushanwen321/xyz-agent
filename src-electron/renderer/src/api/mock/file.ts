/**
 * Mock file domain —— 与 real api/domains/file 同接口（VITE_MOCK=true 时由 api/index 注入）。
 *
 * 行为（D7 工程默认）：返回内存 fixture（最小文件树结构），不走 transport。
 * reload 即重置。供 E2E / mock 开发模式使用。
 */
import type { FileNode } from '@xyz-agent/shared'

/** mock 延迟（与 mock/index TIMING.ack 一致量级） */
const MOCK_ACK_MS = 40

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** mock 文件树 fixture（顶层 + 一级子，模拟小型项目结构） */
const MOCK_TREE: FileNode[] = [
  {
    path: 'src',
    name: 'src',
    type: 'dir',
    children: [
      { path: 'src/index.ts', name: 'index.ts', type: 'file', size: 100 },
      { path: 'src/utils', name: 'utils', type: 'dir' },
    ],
  },
  { path: 'package.json', name: 'package.json', type: 'file', size: 200 },
  { path: 'README.md', name: 'README.md', type: 'file', size: 500 },
]

/** mock 展开目录的子节点 fixture */
const MOCK_EXPAND: Record<string, FileNode[]> = {
  'src/utils': [
    { path: 'src/utils/format.ts', name: 'format.ts', type: 'file', size: 50 },
  ],
}

export const file = {
  async tree(_sessionId: string, _showIgnored?: boolean): Promise<FileNode[]> {
    await sleep(MOCK_ACK_MS)
    return MOCK_TREE.map((n) => ({ ...n, children: n.children?.map((c) => ({ ...c })) }))
  },

  async expand(_sessionId: string, path: string, _showIgnored?: boolean): Promise<FileNode[]> {
    await sleep(MOCK_ACK_MS)
    return (MOCK_EXPAND[path] ?? []).map((n) => ({ ...n }))
  },

  async read(_path: string): Promise<{ content: string; truncated: boolean }> {
    await sleep(MOCK_ACK_MS)
    return { content: '// mock file content', truncated: false }
  },
}
