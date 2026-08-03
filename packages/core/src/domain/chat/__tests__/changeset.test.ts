/**
 * domain/chat changeset 迁移单测（语义等价锁定，w2 原样迁移）。
 *
 * 锁定 mergeFileChanges 增量合并语义（ADR-0024 D5 baseline diff）：
 * - 同 filePath 取 incoming 最新项（status 覆盖）
 * - addLines/delLines：incoming 未带则沿用 baseline（继承语义）
 * - ready 全集替换：baseline=[] 时纯取 incoming
 *
 * （createChangeSetController 的 applyFileChanges/markChangeSetsSuperseded 依赖 messages ref +
 *  commitMessages，属 store 编排层，行为锁定在 renderer 集成测试。本 core 测试聚焦纯函数。）
 */
import { describe, it, expect } from 'vitest'
import type { FileChange } from '@xyz-agent/shared'
import { mergeFileChanges } from '../changeset'

function fc(filePath: string, extra: Partial<FileChange> = {}): FileChange {
  return { filePath, status: 'modified', ...extra } as FileChange
}

describe('mergeFileChanges', () => {
  it('incoming 为空时原样返回 baseline', () => {
    const baseline = [fc('a.ts'), fc('b.ts')]
    expect(mergeFileChanges([], baseline)).toEqual(baseline)
  })

  it('baseline 为空时原样返回 incoming（ready 全集替换语义）', () => {
    const incoming = [fc('a.ts', { status: 'added' })]
    expect(mergeFileChanges(incoming, [])).toEqual(incoming)
  })

  it('同 filePath：incoming 覆盖 baseline 的 status', () => {
    const baseline = [fc('a.ts', { status: 'modified' })]
    const incoming = [fc('a.ts', { status: 'deleted' })]
    const result = mergeFileChanges(incoming, baseline)
    expect(result).toHaveLength(1)
    expect(result[0].filePath).toBe('a.ts')
    expect(result[0].status).toBe('deleted') // 被覆盖
  })

  it('不同 filePath：incoming 与 baseline 并集', () => {
    const baseline = [fc('a.ts')]
    const incoming = [fc('b.ts')]
    const result = mergeFileChanges(incoming, baseline)
    expect(result.map((c) => c.filePath).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('addLines/delLines 继承：incoming 未带时沿用 baseline', () => {
    const baseline = [fc('a.ts', { addLines: 10, delLines: 2 })]
    const incoming = [fc('a.ts', { status: 'modified' })] // 未带 addLines/delLines
    const result = mergeFileChanges(incoming, baseline)
    expect(result[0].addLines).toBe(10) // 沿用 baseline
    expect(result[0].delLines).toBe(2) // 沿用 baseline
  })

  it('addLines/delLines 覆盖：incoming 带时用 incoming 的', () => {
    const baseline = [fc('a.ts', { addLines: 10, delLines: 2 })]
    const incoming = [fc('a.ts', { addLines: 5, delLines: 1 })]
    const result = mergeFileChanges(incoming, baseline)
    expect(result[0].addLines).toBe(5) // incoming 覆盖
    expect(result[0].delLines).toBe(1) // incoming 覆盖
  })

  it('addLines/delLines 双向独立继承：incoming 只带 addLines 时 delLines 沿用 baseline', () => {
    const baseline = [fc('a.ts', { addLines: 10, delLines: 2 })]
    const incoming = [fc('a.ts', { addLines: 7 })] // 只带 addLines
    const result = mergeFileChanges(incoming, baseline)
    expect(result[0].addLines).toBe(7) // incoming
    expect(result[0].delLines).toBe(2) // 沿用 baseline
  })

  it('baseline 与 incoming 都不带 addLines/delLines：结果也不带', () => {
    const baseline = [fc('a.ts')]
    const incoming = [fc('a.ts', { status: 'modified' })]
    const result = mergeFileChanges(incoming, baseline)
    expect(result[0].addLines).toBeUndefined()
    expect(result[0].delLines).toBeUndefined()
  })
})
