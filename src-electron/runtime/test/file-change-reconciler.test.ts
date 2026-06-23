/**
 * file-change-reconciler 单测（ADR-0024 D5）。
 *
 * 覆盖纯函数（parseGitStatusPorcelain / xyToStatus / mergeWithIncremental），
 * 不覆盖 execSync 路径（reconcileFileChanges 依赖外部 git，集成测试覆盖）。
 *
 * 运行：cd src-electron/runtime && npx vitest run test/file-change-reconciler.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  parseGitStatusPorcelain,
  xyToStatus,
  mergeWithIncremental,
} from '../src/infra/pi/file-change-reconciler.js'

describe('file-change-reconciler', () => {
  describe('parseGitStatusPorcelain', () => {
    it('解析标准 A/M/D/?? 条目', () => {
      const output = [
        'A  src/new.ts',
        ' M src/modified.ts',
        'D  src/deleted.ts',
        '?? src/untracked.ts',
      ].join('\n')
      const entries = parseGitStatusPorcelain(output)
      expect(entries).toHaveLength(4)
      expect(entries[0]).toEqual({ xy: 'A ', path: 'src/new.ts' })
      expect(entries[1]).toEqual({ xy: ' M', path: 'src/modified.ts' })
      expect(entries[2]).toEqual({ xy: 'D ', path: 'src/deleted.ts' })
      expect(entries[3]).toEqual({ xy: '??', path: 'src/untracked.ts' })
    })

    it('解析重命名条目（取目标路径）', () => {
      const entries = parseGitStatusPorcelain('R  src/old.ts -> src/new.ts')
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({ xy: 'R ', path: 'src/new.ts' })
    })

    it('空输出返回空数组', () => {
      expect(parseGitStatusPorcelain('')).toEqual([])
    })
  })

  describe('xyToStatus', () => {
    it('未跟踪 ?? → added', () => {
      expect(xyToStatus('??')).toBe('added')
    })
    it('新增 A → added', () => {
      expect(xyToStatus('A ')).toBe('added')
    })
    it('修改 M（staged/working）→ modified', () => {
      expect(xyToStatus('M ')).toBe('modified')
      expect(xyToStatus(' M')).toBe('modified')
    })
    it('删除 D（staged/working）→ deleted', () => {
      expect(xyToStatus('D ')).toBe('deleted')
      expect(xyToStatus(' D')).toBe('deleted')
    })
    it('重命名/拷贝 R/C → modified（目标路径）', () => {
      expect(xyToStatus('R ')).toBe('modified')
      expect(xyToStatus('C ')).toBe('modified')
    })
  })

  describe('mergeWithIncremental', () => {
    it('git 全集优先（同 filePath 以 git status 为准，真值收口）', () => {
      const gitSet = [{ filePath: 'a.ts', status: 'added' as const }]
      const incremental = [{ filePath: 'a.ts', status: 'modified' as const, addLines: 5 }]
      const merged = mergeWithIncremental(gitSet, incremental)
      expect(merged).toHaveLength(1)
      // status 取 git 的 added（真值），行数保留增量的 addLines
      expect(merged[0].status).toBe('added')
      expect(merged[0].addLines).toBe(5)
    })

    it('git null（非仓库）→ 仅用增量提取', () => {
      const incremental = [{ filePath: 'a.ts', status: 'modified' as const }]
      const merged = mergeWithIncremental(null, incremental)
      expect(merged).toEqual(incremental)
    })

    it('补增量提取独有（git 未追踪的文件）', () => {
      const gitSet = [{ filePath: 'a.ts', status: 'modified' as const }]
      const incremental = [
        { filePath: 'a.ts', status: 'modified' as const },
        { filePath: 'ignored.log', status: 'added' as const }, // git 忽略
      ]
      const merged = mergeWithIncremental(gitSet, incremental)
      expect(merged).toHaveLength(2)
      expect(merged.map((c) => c.filePath).sort()).toEqual(['a.ts', 'ignored.log'])
    })
  })
})
