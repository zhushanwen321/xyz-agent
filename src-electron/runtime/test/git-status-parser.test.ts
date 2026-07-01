/**
 * git-status-parser 单测（vitest）。
 * 覆盖：parseGitStatus（-z NUL 分隔 + branch 头 + 重命名双记录）、xyToGitStatus（全枚举）、
 * deriveCounts（staged/unstaged/hasConflict 计数 + 未跟踪计入 unstaged）、parseNumstat。
 */
import { describe, it, expect } from 'vitest'
import { parseGitStatus, xyToGitStatus, deriveCounts, parseNumstat, parseNumstatByFile } from '../src/infra/git-status-parser.js'
import type { GitFileStatus } from '@xyz-agent/shared'

describe('xyToGitStatus', () => {
  it('maps unmerged XY codes (U*/DD/AA)', () => {
    expect(xyToGitStatus('UU')).toBe('unmerged')
    expect(xyToGitStatus('DU')).toBe('unmerged')
    expect(xyToGitStatus('UD')).toBe('unmerged')
    expect(xyToGitStatus('AA')).toBe('unmerged')
    expect(xyToGitStatus('DD')).toBe('unmerged')
  })
  it('maps untracked', () => {
    expect(xyToGitStatus('??')).toBe('untracked')
  })
  it('maps added (staged A)', () => {
    expect(xyToGitStatus('A ')).toBe('added')
    expect(xyToGitStatus('AM')).toBe('added')
  })
  it('maps deleted (X or Y D)', () => {
    expect(xyToGitStatus('D ')).toBe('deleted')
    expect(xyToGitStatus(' D')).toBe('deleted')
  })
  it('maps renamed/copy (X R/C)', () => {
    expect(xyToGitStatus('R ')).toBe('renamed')
    expect(xyToGitStatus('C ')).toBe('renamed')
  })
  it('maps modified (M, fallback)', () => {
    expect(xyToGitStatus(' M')).toBe('modified')
    expect(xyToGitStatus('M ')).toBe('modified')
    expect(xyToGitStatus('T ')).toBe('modified')
  })
})

describe('parseGitStatus', () => {
  it('parses empty output', () => {
    expect(parseGitStatus('')).toEqual({ files: [] })
  })
  it('parses branch header + multiple files (NUL-delimited)', () => {
    const out = ['## main...origin/main', 'A \tsrc/a.ts', ' M\tREADME.md', '??\tlog.tmp'].join('\0')
    const res = parseGitStatus(out)
    expect(res.branch).toBe('main')
    expect(res.files).toHaveLength(3)
    expect(res.files[0]).toEqual({ path: 'src/a.ts', xyCode: 'A ', status: 'added' })
    expect(res.files[2]).toEqual({ path: 'log.tmp', xyCode: '??', status: 'untracked' })
  })
  it('handles rename: target path kept, source record skipped', () => {
    // `R  new.ts\0old.ts` — X=R → next NUL record is source path (skipped)
    const out = ['## main', 'R \tnew.ts', 'old.ts'].join('\0')
    const res = parseGitStatus(out)
    expect(res.files).toHaveLength(1)
    expect(res.files[0]).toEqual({ path: 'new.ts', xyCode: 'R ', status: 'renamed' })
  })
  it('detached HEAD → branch undefined', () => {
    const out = '## HEAD (no branch)\0A \tx.ts'
    expect(parseGitStatus(out).branch).toBeUndefined()
  })
  it('branch without upstream', () => {
    expect(parseGitStatus('## feature\x00').branch).toBe('feature')
  })
  it('path with spaces preserved (NUL safety)', () => {
    const out = '## main\0M \tmy file with spaces.ts'
    const res = parseGitStatus(out)
    expect(res.files[0]?.path).toBe('my file with spaces.ts')
  })
})

describe('deriveCounts', () => {
  const f = (xyCode: string, status: GitFileStatus['status']): GitFileStatus => ({ path: 'p', xyCode, status })
  it('counts staged (X col changed, not space/?)', () => {
    const files = [f('A ', 'added'), f('M ', 'modified'), f('R ', 'renamed')]
    expect(deriveCounts(files).stagedCount).toBe(3)
  })
  it('counts unstaged (Y col changed) + untracked', () => {
    const files = [f(' M', 'modified'), f(' D', 'deleted'), f('??', 'untracked')]
    const c = deriveCounts(files)
    expect(c.unstagedCount).toBe(3)
    expect(c.stagedCount).toBe(0)
  })
  it('mixed: AM counts staged only (Y=M would double — verify single staged)', () => {
    // 'AM': X=A (staged), Y=M (unstaged) → staged=1, unstaged=1
    const files = [f('AM', 'added')]
    const c = deriveCounts(files)
    expect(c.stagedCount).toBe(1)
    expect(c.unstagedCount).toBe(1)
  })
  it('hasConflict true when any unmerged', () => {
    expect(deriveCounts([f('UU', 'unmerged')]).hasConflict).toBe(true)
    expect(deriveCounts([f(' M', 'modified')]).hasConflict).toBe(false)
  })
})

describe('parseNumstat', () => {
  it('sums add/del columns', () => {
    expect(parseNumstat('12\t3\ta.ts\n5\t0\tb.ts')).toEqual({ add: 17, del: 3 })
  })
  it('skips binary (- counts) and empty lines', () => {
    expect(parseNumstat('-\t-\tbin\n10\t2\tc.ts')).toEqual({ add: 10, del: 2 })
  })
  it('empty output → zeros', () => {
    expect(parseNumstat('')).toEqual({ add: 0, del: 0 })
  })
})

describe('parseNumstatByFile', () => {
  it('多文件 → Map 含每文件 {add, del}', () => {
    const m = parseNumstatByFile('10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts')
    expect(m.size).toBe(2)
    expect(m.get('src/a.ts')).toEqual({ add: 10, del: 2 })
    expect(m.get('src/b.ts')).toEqual({ add: 5, del: 0 })
  })
  it('二进制文件（add/del 为 -）跳过，不进 Map', () => {
    const m = parseNumstatByFile('-\t-\timg.png\n3\t1\tcode.ts')
    expect(m.size).toBe(1)
    expect(m.has('img.png')).toBe(false)
    expect(m.get('code.ts')).toEqual({ add: 3, del: 1 })
  })
  it('空输入 → 空 Map', () => {
    expect(parseNumstatByFile('').size).toBe(0)
  })
  it('单文件 → Map 含一项', () => {
    const m = parseNumstatByFile('7\t4\tlib/util.ts')
    expect(m.size).toBe(1)
    expect(m.get('lib/util.ts')).toEqual({ add: 7, del: 4 })
  })
})
