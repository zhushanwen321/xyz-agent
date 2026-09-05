/**
 * check-core-dist-gate.mjs 纯函数单测（MF-2）：
 * stripComments / parseExportBlocks / collectBundleClosure / extractSrcExportNames
 * 是发布门禁的文本解析核心，边界（嵌套块注释、字符串内 //、空/畸形 export 块）出错
 * 会误拦/漏放发布门禁——零覆盖的 433 行解析逻辑必须机器锁定。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  stripComments,
  parseExportBlocks,
  collectBundleClosure,
  extractSrcExportNames,
} from '../check-core-dist-gate.mjs'

describe('stripComments', () => {
  it('行注释剥离、换行保留', () => {
    expect(stripComments('a // trailing\nb')).toBe('a \nb')
  })
  it('块注释剥离到首个 */（JS 语义块注释不嵌套，内层 /* 是普通字符）', () => {
    expect(stripComments('a /* outer /* inner */ b */ c')).toBe('a  b */ c')
  })
  it('字符串字面量内的 // 与 /* 不当注释剥离', () => {
    expect(stripComments(`const u = "http://x" // real`)).toBe('const u = "http://x" ')
    expect(stripComments(`const s = 'a/*b'`)).toBe(`const s = 'a/*b'`)
  })
  it('转义引号不结束字符串状态', () => {
    expect(stripComments(`const s = "a\\"//b"; // c`)).toBe(`const s = "a\\"//b"; `)
  })
  it('未闭合块注释越过后安全结束（fail-closed 倾向，不抛）', () => {
    expect(stripComments('a /* never closed')).toBe('a ')
  })
})

describe('parseExportBlocks', () => {
  it('多行块 + type 前缀 + as 重命名 + 空项', () => {
    const problems = []
    const names = parseExportBlocks(
      'export {\n  foo,\n  type Bar,\n  baz as qux,\n  ,\n  default as def,\n}',
      problems,
      't',
    )
    expect([...names].sort()).toEqual(['Bar', 'def', 'foo', 'qux'])
    expect(problems).toEqual([])
  })
  it('未闭合花括号 fail-closed 记 problems', () => {
    const problems = []
    const names = parseExportBlocks('export { a, b', problems, 't')
    expect([...names]).toEqual([])
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('花括号未闭合')
  })
  it('无法解析的导出项记 problems（不静默漏符号）', () => {
    const problems = []
    parseExportBlocks('export { a.b }', problems, 't')
    expect(problems.some((p) => p.includes('a.b'))).toBe(true)
  })
})

describe('collectBundleClosure', () => {
  it('沿相对 import 递归展开 + module 标记从原文提取（注释里的路径不命中）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-dist-gate-'))
    try {
      const chunkDir = join(dir, 'chunk')
      mkdirSync(chunkDir)
      writeFileSync(
        join(dir, 'entry.js'),
        [
          '// src/a.ts',
          `import "./chunk/c.js"`,
          `const x = require("./b.cjs")`,
        ].join('\n'),
      )
      writeFileSync(join(dir, 'b.cjs'), '// src/b.ts\nmodule.exports = 1')
      writeFileSync(
        join(chunkDir, 'c.js'),
        [
          '// 注释里写 // src/fake.ts 不算 marker（不在行首整段形态）',
          '// src/c.ts',
          'export {}',
        ].join('\n'),
      )
      const markers = collectBundleClosure(join(dir, 'entry.js'))
      expect(markers.has('src/a.ts')).toBe(true)
      expect(markers.has('src/b.ts')).toBe(true)
      expect(markers.has('src/c.ts')).toBe(true)
      expect(markers.has('src/fake.ts')).toBe(false)
      expect(markers.has('src/c.ts')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('extractSrcExportNames', () => {
  it('声明形态 + export 块 + default + export * as；裸 export * fail-closed', () => {
    const src = [
      'export const A = 1',
      'export declare async function B(): void',
      'export type T = number',
      'export interface I {}',
      'export { C as D }',
      'export default class E {}',
      'export * as NS from "./x"',
    ].join('\n')
    const { names, problems } = extractSrcExportNames(src, 't')
    expect([...names].sort()).toEqual(['A', 'B', 'D', 'I', 'NS', 'T', 'default'])
    expect(problems).toEqual([])
  })
  it('裸 export * from 记 problems（重导出面无法文本枚举）', () => {
    const { problems } = extractSrcExportNames('export * from "./x"', 't')
    expect(problems.some((p) => p.includes('export * from'))).toBe(true)
  })
})
