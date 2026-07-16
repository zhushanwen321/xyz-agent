/**
 * Segment 归一化函数单测（ADR-0037）。
 *
 * 覆盖 segmentsToText / segmentsToPrompt / textToSegments / normalizeContent。
 * 重点：segmentsToText 不 trim（保留末尾换行），segmentsToPrompt trim（pi 边界）。
 */
import { describe, it, expect } from 'vitest'
import {
  segmentsToText,
  segmentsToPrompt,
  textToSegments,
  normalizeContent,
  type Segment,
} from '../segments'

describe('segmentsToText', () => {
  it('空数组返回空字符串', () => {
    expect(segmentsToText([])).toBe('')
  })

  it('纯 text segment 原样返回', () => {
    expect(segmentsToText([{ type: 'text', text: 'hello' }])).toBe('hello')
  })

  it('skill segment 序列化为 /skill:name', () => {
    expect(segmentsToText([{ type: 'skill', name: 'cw-cli' }])).toBe('/skill:cw-cli')
  })

  it('skill + text 之间补空格', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'cw-cli' },
      { type: 'text', text: '想要都修复' },
    ]
    expect(segmentsToText(segs)).toBe('/skill:cw-cli 想要都修复')
  })

  it('skill + text（text 已含前导空格）不重复补空格', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'cw-cli' },
      { type: 'text', text: ' 想要都修复' },
    ]
    expect(segmentsToText(segs)).toBe('/skill:cw-cli 想要都修复')
  })

  it('不 trim 末尾换行（保留 <br> 产生的 \\n）', () => {
    expect(segmentsToText([{ type: 'text', text: 'line\n' }])).toBe('line\n')
  })

  it('skill 带 location 不影响文本序列化', () => {
    const segs: Segment[] = [{ type: 'skill', name: 'cw-cli', location: '/path/SKILL.md' }]
    expect(segmentsToText(segs)).toBe('/skill:cw-cli')
  })

  it('file 无行范围序列化为 path', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts' }])).toBe('src/foo.ts')
  })

  it('file 单行范围序列化为 path:L<n>（D2）', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts', lineRange: [10, 10] }])).toBe(
      'src/foo.ts:L10',
    )
  })

  it('file 多行范围序列化为 path:L<s>-L<e>（D2，review M1 回归）', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts', lineRange: [10, 20] }])).toBe(
      'src/foo.ts:L10-L20',
    )
  })
})

describe('segmentsToPrompt', () => {
  it('与 segmentsToText 相同内容但 trim 首尾空白', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'cw-cli' },
      { type: 'text', text: '想要都修复\n' },
    ]
    expect(segmentsToPrompt(segs)).toBe('/skill:cw-cli 想要都修复')
  })

  it('空数组返回空字符串', () => {
    expect(segmentsToPrompt([])).toBe('')
  })
})

describe('textToSegments', () => {
  it('纯文本产出单个 text segment', () => {
    expect(textToSegments('hello')).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('空字符串返回空数组', () => {
    expect(textToSegments('')).toEqual([])
  })
})

describe('normalizeContent', () => {
  it('string 直传', () => {
    expect(normalizeContent('plain string')).toBe('plain string')
  })

  it('Segment[] 走 segmentsToText', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'cw-cli' },
      { type: 'text', text: '想要都修复' },
    ]
    expect(normalizeContent(segs)).toBe('/skill:cw-cli 想要都修复')
  })

  it('空 Segment[] 返回空字符串', () => {
    expect(normalizeContent([])).toBe('')
  })
})
