/**
 * git-status-parser 单测（vitest）。
 * 覆盖：parseGitStatus（-z NUL 分隔 + branch 头 + 重命名双记录）、xyToGitStatus（全枚举）、
 * deriveCounts（staged/unstaged/hasConflict 计数 + 未跟踪计入 unstaged）、parseNumstatEntries。
 *
 * W17 审查 Fix-5：原 parseNumstat（聚合）/ parseNumstatByFile（per-file Map）薄包装无生产
 * 消费方已删除，其用例随之移除——等价覆盖锚点：聚合/per-file 语义由
 * git-state-service.test.ts「微项 8 单趟解析边界」用例承担（二进制跳过、半二进制只计数字列、
 * per-file 双值均数字才收录）；行级解析边界（lossless / tab 路径 / 空输入）见下方
 * parseNumstatEntries 与 git-status-parser-shared.test.ts。
 */
import { describe, it, expect } from 'vitest'
import { parseGitStatus, xyToGitStatus, deriveCounts, parseNumstatEntries } from '../src/infra/git/git-status-parser.js'
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

describe('parseNumstatEntries', () => {
  it('lossless：二进制（-/-）→ add/del 为 undefined（不丢弃条目）', () => {
    const entries = parseNumstatEntries('-\t-\tbinary.png')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ add: undefined, del: undefined, path: 'binary.png' })
  })

  it('lossless：单字段为 -（add 有效、del 二进制）→ add 保留、del undefined', () => {
    const entries = parseNumstatEntries('5\t-\tmixed.bin')
    expect(entries).toHaveLength(1)
    expect(entries[0].add).toBe(5)
    expect(entries[0].del).toBeUndefined()
  })

  it('路径含 tab（第 3 列起 join tab 还原）', () => {
    const entries = parseNumstatEntries('1\t0\tweird\tname.ts')
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('weird\tname.ts')
  })

  it('空输出 → 空数组', () => {
    expect(parseNumstatEntries('')).toEqual([])
  })
})
