/**
 * file-candidates 纯函数单测（G16 DTO 映射）。
 *
 * 覆盖 FileNode[] → FileCandidate[] 映射：
 * - 目录补尾随斜杠 + kind='目录'
 * - 文件保持 basename + kind='文件'
 * - id/path/type 透传
 * - 空数组
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/lib/file-candidates.test.ts
 */
import { describe, it, expect } from 'vitest'
import { toFileCandidates } from '@/lib/file-candidates'
import type { FileNode } from '@xyz-agent/shared'

describe('toFileCandidates (G16 DTO 映射)', () => {
  it('U18 目录补斜杠 + 中文 kind，文件保持 basename', () => {
    const nodes: FileNode[] = [
      { path: 'src', name: 'src', type: 'dir' },
      { path: 'a.ts', name: 'a.ts', type: 'file' },
    ]

    const result = toFileCandidates(nodes)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 'src', name: 'src/', kind: '目录', path: 'src', type: 'dir' })
    expect(result[1]).toMatchObject({ id: 'a.ts', name: 'a.ts', kind: '文件', path: 'a.ts', type: 'file' })
  })

  it('U19 空数组 → 空数组', () => {
    expect(toFileCandidates([])).toEqual([])
  })

  it('嵌套路径：深层文件 path 透传，name 取 basename', () => {
    const nodes: FileNode[] = [
      { path: 'src/auth/token.ts', name: 'token.ts', type: 'file' },
    ]

    const result = toFileCandidates(nodes)

    expect(result[0]).toMatchObject({ id: 'src/auth/token.ts', name: 'token.ts', kind: '文件', path: 'src/auth/token.ts' })
  })
})
