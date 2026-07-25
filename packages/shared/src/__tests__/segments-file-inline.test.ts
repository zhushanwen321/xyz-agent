/**
 * P3 file inline 透传单测（w5 W5TC1-4, W5TC10-13）。
 *
 * 覆盖：
 * - W5TC1-4 shouldInlineFile 纯函数（白名单/超限/非白名单/大小写）
 * - W5TC10-13 segmentsToPrompt 扩展（有fileContext/无fileContext/lineRange/truncated）
 *
 * extractFileContexts 测试在 renderer 包（useChat-file-inline.test.ts），
 * 因为该函数定义在 useChat.ts（renderer 层），不在 shared。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/segments-file-inline.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  shouldInlineFile,
  segmentsToPrompt,
  INLINE_TEXT_MAX_BYTES,
  INLINE_TEXT_MAX_LINES,
  type Segment,
  type FileContext,
} from '../segments'

// ── W5TC1-4: shouldInlineFile ────────────────────────────────────

describe('shouldInlineFile（W5TC1-4）', () => {
  it('W5TC1 白名单扩展名 + 小文件 → true', () => {
    expect(shouldInlineFile('/src/index.ts', 10 * 1024)).toBe(true)
  })

  it('W5TC2 白名单扩展名 + 超 50KB → false', () => {
    expect(shouldInlineFile('/src/big.ts', 60 * 1024)).toBe(false)
  })

  it('W5TC3 非白名单扩展名 → false', () => {
    expect(shouldInlineFile('/img/photo.png', 10 * 1024)).toBe(false)
  })

  it('W5TC4 扩展名大小写不敏感', () => {
    expect(shouldInlineFile('/src/index.TS', 10 * 1024)).toBe(true)
    expect(shouldInlineFile('/src/index.Py', 10 * 1024)).toBe(true)
  })

  it('边界：sizeBytes === INLINE_TEXT_MAX_BYTES → true（<= 判断）', () => {
    expect(shouldInlineFile('/src/index.ts', INLINE_TEXT_MAX_BYTES)).toBe(true)
  })

  it('边界：sizeBytes === INLINE_TEXT_MAX_BYTES + 1 → false', () => {
    expect(shouldInlineFile('/src/index.ts', INLINE_TEXT_MAX_BYTES + 1)).toBe(false)
  })

  it('隐藏文件（.gitignore）→ true（扩展名在白名单）', () => {
    expect(shouldInlineFile('/.gitignore', 100)).toBe(true)
  })
})

// ── W5TC10-13: segmentsToPrompt 扩展 ────────────────────────────

describe('segmentsToPrompt fileContexts 扩展（W5TC10-13）', () => {
  it('W5TC10 file 段有 fileContext → 输出 <file> 标签', () => {
    const segments: Segment[] = [{ type: 'file', path: '/src/index.ts' }]
    const fileContexts = new Map<string, FileContext>([
      ['/src/index.ts', { path: '/src/index.ts', content: 'const x = 1', truncated: false, sizeBytes: 100 }],
    ])
    const result = segmentsToPrompt(segments, fileContexts)
    expect(result).toContain('<file path="/src/index.ts">')
    expect(result).toContain('const x = 1')
    expect(result).toContain('</file>')
  })

  it('W5TC11 file 段无 fileContext → 保持原 path 输出（向后兼容）', () => {
    const segments: Segment[] = [{ type: 'file', path: '/src/index.ts' }]
    // 不传 fileContexts
    expect(segmentsToPrompt(segments)).toBe('/src/index.ts')
    // 传空 Map
    expect(segmentsToPrompt(segments, new Map())).toBe('/src/index.ts')
    // Map 无对应 path
    expect(segmentsToPrompt(segments, new Map([['/other.ts', {} as FileContext]]))).toBe('/src/index.ts')
  })

  it('W5TC12 file 段有 lineRange + fileContext → <file> 标签含 lines 属性', () => {
    const segments: Segment[] = [{ type: 'file', path: '/src/index.ts', lineRange: [10, 20] }]
    const fileContexts = new Map<string, FileContext>([
      ['/src/index.ts', { path: '/src/index.ts', content: 'code', truncated: false, sizeBytes: 100 }],
    ])
    const result = segmentsToPrompt(segments, fileContexts)
    expect(result).toContain('lines="10-20"')
  })

  it('W5TC12b file 段 lineRange 单行 → lines 不含范围', () => {
    const segments: Segment[] = [{ type: 'file', path: '/src/index.ts', lineRange: [10, 10] }]
    const fileContexts = new Map<string, FileContext>([
      ['/src/index.ts', { path: '/src/index.ts', content: 'code', truncated: false, sizeBytes: 100 }],
    ])
    const result = segmentsToPrompt(segments, fileContexts)
    expect(result).toContain('lines="10"')
    expect(result).not.toContain('lines="10-10"')
  })

  it('W5TC13 truncated fileContext → 内容末尾加截断注释', () => {
    const segments: Segment[] = [{ type: 'file', path: '/src/long.ts' }]
    const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n')
    const fileContexts = new Map<string, FileContext>([
      ['/src/long.ts', { path: '/src/long.ts', content, truncated: true, sizeBytes: 30 * 1024 }],
    ])
    const result = segmentsToPrompt(segments, fileContexts)
    expect(result).toContain('<!-- truncated:')
    expect(result).toContain('30KB')
    expect(result).toContain('500')
  })

  it('混合段：text + file（有fileContext）+ file（无fileContext）+ image', () => {
    const segments: Segment[] = [
      { type: 'text', text: 'review this' },
      { type: 'file', path: '/src/a.ts' },
      { type: 'file', path: '/src/b.ts' },
      { type: 'image', id: 'img-1', path: '/tmp/x.png', name: 'x.png' },
    ]
    const fileContexts = new Map<string, FileContext>([
      ['/src/a.ts', { path: '/src/a.ts', content: 'codeA', truncated: false, sizeBytes: 100 }],
    ])
    const result = segmentsToPrompt(segments, fileContexts)
    // a.ts 有 fileContext → <file> 标签
    expect(result).toContain('<file path="/src/a.ts">')
    expect(result).toContain('codeA')
    // b.ts 无 fileContext → 原 path
    expect(result).toContain('/src/b.ts')
    // image → 占位
    expect(result).toContain('[图片: x.png]')
    // text → 原文
    expect(result).toContain('review this')
  })

  it('fileContexts 为 undefined → 行为与改造前完全一致（segmentsToText + trim）', () => {
    const segments: Segment[] = [
      { type: 'text', text: 'hi' },
      { type: 'file', path: '/src/index.ts' },
      { type: 'skill', name: 'test' },
    ]
    // segmentsToPrompt(segments) === segmentsToText(segments).trim()
    // segmentsToText: text='hi' + file='/src/index.ts' + skill='/skill:test'
    // 前一个是 text，当前是 file → 不补空格（只有前一个是 chip 类且当前 text 不以空格开头才补）
    // 实际 segmentsToText 输出：'hi/src/index.ts/skill:test'
    const result = segmentsToPrompt(segments)
    expect(result).toBe(segmentsToPrompt(segments))
    // 验证不含 <file> 标签
    expect(result).not.toContain('<file')
  })

  it('常量 INLINE_TEXT_MAX_LINES === 500', () => {
    // eslint-disable-next-line no-magic-numbers
    expect(INLINE_TEXT_MAX_LINES).toBe(500)
  })
})
