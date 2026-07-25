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

  it('file lineRange 归一化：负数起点钳到 1', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts', lineRange: [-3, 5] }])).toBe(
      'src/foo.ts:L1-L5',
    )
  })

  it('file lineRange 归一化：s>e 时 e 抬到 s（退化为单行）', () => {
    expect(segmentsToText([{ type: 'file', path: 'src/foo.ts', lineRange: [20, 10] }])).toBe(
      'src/foo.ts:L20',
    )
  })

  it('image segment 序列化为 [图片 N] 匿名编号占位', () => {
    const segs: Segment[] = [
      {
        type: 'image',
        id: 'img-1',
        path: '/var/folders/xx/T/dbfdb3c8-image.png',
        fileName: 'dbfdb3c8-image.png',
        displayName: 'screenshot-20260724-1530.png',
      },
    ]
    const result = segmentsToText(segs)
    expect(result).toBe('[图片 1]')
    // 不含 path 绝对路径（不暴露系统路径）
    expect(result).not.toContain('/var/folders')
    // 不含 fileName（磁盘全名不暴露给 LLM）
    expect(result).not.toContain('dbfdb3c8')
    // 不含 displayName（用户可读名不污染 LLM 上下文）
    expect(result).not.toContain('screenshot-20260724')
    // 不含 base64 标记
    expect(result).not.toMatch(/data:image/)
  })

  it('image + text 混合时中间补空格', () => {
    const segs: Segment[] = [
      { type: 'image', id: 'img-a', path: '/tmp/a.png', fileName: 'a.png', displayName: 'a.png' },
      { type: 'text', text: '这张图怎么修' },
    ]
    expect(segmentsToText(segs)).toBe('[图片 1] 这张图怎么修')
  })

  it('连续多个 image segment 编号递增', () => {
    const segs: Segment[] = [
      { type: 'image', id: 'img-1', path: '/tmp/1.png', fileName: '1.png', displayName: '1.png' },
      { type: 'image', id: 'img-2', path: '/tmp/2.png', fileName: '2.png', displayName: '2.png' },
    ]
    expect(segmentsToText(segs)).toBe('[图片 1][图片 2]')
  })

  it('image segment 不破坏既有 text/skill 序列化（回归）', () => {
    // 混合 image 与既有类型，确认 image 的加入不影响 text/skill 的序列化。
    // 补空格逻辑只在「当前段是 text && prev 段不是 text」时触发（segments.ts L52）。
    // 这里 text 在前（首段，prev=null 不补空格）；image/skill 都不是 text，不触发补空格，
    // 因此 image 与 skill 直接拼接，中间无空格。
    const segs: Segment[] = [
      { type: 'text', text: '看这张' },
      { type: 'image', id: 'img-x', path: '/tmp/x.png', fileName: 'x.png', displayName: 'x.png' },
      { type: 'skill', name: 'review' },
    ]
    expect(segmentsToText(segs)).toBe('看这张[图片 1]/skill:review')
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
