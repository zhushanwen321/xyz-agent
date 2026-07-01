/**
 * file-change-reconciler 单测（ADR-0024 D5 重构：baseline diff 引擎）。
 *
 * 覆盖纯函数：parseGitStatusPorcelain / xyToStatus / diffSnapshots / parseNumstat。
 * snapshotGitStatus / computeLineCounts 依赖外部 git（execSync），集成测试覆盖。
 *
 * 运行：cd src-electron/runtime && npx vitest run test/file-change-reconciler.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { FileChangeStatus } from '@xyz-agent/shared'
import {
  parseGitStatusPorcelain,
  xyToStatus,
  diffSnapshots,
  parseNumstat,
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

  describe('diffSnapshots', () => {
    /** 辅助：构造快照（filePath → status） */
    const snap = (entries: Record<string, FileChangeStatus>) => new Map(Object.entries(entries))

    it('current 有 baseline 无 → 新增文件（added）', () => {
      const baseline = snap({ 'src/a.ts': 'modified' })
      const current = snap({ 'src/a.ts': 'modified', 'src/new.ts': 'added' })
      const changes = diffSnapshots(baseline, current)
      expect(changes).toHaveLength(1)
      expect(changes[0]).toEqual({ filePath: 'src/new.ts', status: 'added' })
    })

    it('两者都有但 status 变化 → 报告新 status', () => {
      const baseline = snap({ 'src/a.ts': 'modified' })
      const current = snap({ 'src/a.ts': 'deleted' })
      const changes = diffSnapshots(baseline, current)
      expect(changes).toHaveLength(1)
      expect(changes[0]).toEqual({ filePath: 'src/a.ts', status: 'deleted' })
    })

    it('status 相同 → 不报告（无变化）', () => {
      const baseline = snap({ 'src/a.ts': 'modified', 'src/b.ts': 'added' })
      const current = snap({ 'src/a.ts': 'modified', 'src/b.ts': 'added' })
      expect(diffSnapshots(baseline, current)).toHaveLength(0)
    })

    it('baseline 有 current 无 → 不报告（已 commit/revert）', () => {
      const baseline = snap({ 'src/a.ts': 'modified' })
      const current = snap({})
      expect(diffSnapshots(baseline, current)).toHaveLength(0)
    })

    it('baseline 为 null → current 全集作为变更', () => {
      const current = snap({ 'src/a.ts': 'modified', 'src/b.ts': 'added' })
      const changes = diffSnapshots(null, current)
      expect(changes).toHaveLength(2)
      expect(changes.map((c) => c.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    })

    it('current 为 null → 空数组', () => {
      const baseline = snap({ 'src/a.ts': 'modified' })
      expect(diffSnapshots(baseline, null)).toEqual([])
    })

    it('多文件混合：新增 + 变化 + 消失 + 不变', () => {
      const baseline = snap({
        'keep.ts': 'modified',    // 不变
        'gone.ts': 'modified',    // 消失（已 commit）
        'changing.ts': 'added',   // 变化 → modified
      })
      const current = snap({
        'keep.ts': 'modified',
        'changing.ts': 'modified',
        'brandnew.ts': 'added',   // 新增
      })
      const changes = diffSnapshots(baseline, current)
      expect(changes).toHaveLength(2)
      const byPath = new Map(changes.map((c) => [c.filePath, c.status]))
      expect(byPath.get('changing.ts')).toBe('modified')
      expect(byPath.get('brandnew.ts')).toBe('added')
      // gone.ts 不报告，keep.ts 不报告
      expect(byPath.has('gone.ts')).toBe(false)
      expect(byPath.has('keep.ts')).toBe(false)
    })
  })

  describe('parseNumstat', () => {
    it('解析标准 added/deleted/path', () => {
      const entries = parseNumstat('5\t2\tsrc/a.ts\n10\t0\tsrc/b.ts')
      expect(entries).toHaveLength(2)
      expect(entries[0]).toEqual({ add: 5, del: 2, path: 'src/a.ts' })
      expect(entries[1]).toEqual({ add: 10, del: 0, path: 'src/b.ts' })
    })

    it('二进制文件（-/-）→ undefined', () => {
      const entries = parseNumstat('-\t-\tbinary.png')
      expect(entries).toHaveLength(1)
      expect(entries[0].add).toBeUndefined()
      expect(entries[0].del).toBeUndefined()
    })

    it('路径含 tab（多段 join）', () => {
      const entries = parseNumstat('1\t0\tweird\tname.ts')
      expect(entries).toHaveLength(1)
      expect(entries[0].path).toBe('weird\tname.ts')
    })

    it('空输出返回空数组', () => {
      expect(parseNumstat('')).toEqual([])
    })
  })
})
