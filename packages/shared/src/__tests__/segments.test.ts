/**
 * Segment 归一化函数单测（ADR-0043）。
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

  it('image segment 序列化为裸路径独占一行（对齐 pi TUI）', () => {
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
    expect(result).toBe('\n/var/folders/xx/T/dbfdb3c8-image.png\n')
    // 不含 base64 标记（图片走路径模式，不走 base64）
    expect(result).not.toMatch(/data:image/)
    // 不含 [图片 N] 匿名占位
    expect(result).not.toContain('[图片')
  })

  it('image + text 混合时，image 裸路径独占一行 + text 紧随（不补空格，image 的 \\n 已分隔）', () => {
    const segs: Segment[] = [
      { type: 'image', id: 'img-a', path: '/tmp/a.png', fileName: 'a.png', displayName: 'a.png' },
      { type: 'text', text: '这张图怎么修' },
    ]
    // image 前后补 \n，text 紧接 image 的尾 \n（image 段自带 \n 分隔，紧跟的 text 不补空格，
    // 否则产出 `\n/tmp/a.png\n 这张图怎么修` 行首空格污染 pi prompt）
    expect(segmentsToText(segs)).toBe('\n/tmp/a.png\n这张图怎么修')
  })

  it('skill 后紧跟 text 仍补空格（与 image 区分，skill 无 \\n 分隔）', () => {
    const segs: Segment[] = [
      { type: 'skill', name: 'review' },
      { type: 'text', text: '这段代码' },
    ]
    // skill 无 \n 自分隔，text 紧跟 skill 时仍需补空格，否则产出 `/skill:review这段代码` 粘连
    expect(segmentsToText(segs)).toBe('/skill:review 这段代码')
  })

  it('连续多个 image segment：每个路径独占一行（无编号递增）', () => {
    const segs: Segment[] = [
      { type: 'image', id: 'img-1', path: '/tmp/1.png', fileName: '1.png', displayName: '1.png' },
      { type: 'image', id: 'img-2', path: '/tmp/2.png', fileName: '2.png', displayName: '2.png' },
    ]
    expect(segmentsToText(segs)).toBe('\n/tmp/1.png\n\n/tmp/2.png\n')
  })

  it('image segment 不破坏既有 text/skill 序列化（回归）', () => {
    // 混合 image 与既有类型，确认 image 的加入不影响 text/skill 的序列化。
    // 补空格逻辑只在「当前段是 text && prev 段不是 text」时触发。
    // 这里 text 在前（首段，prev=null 不补空格）；image 独占一行（\n 包裹）；
    // skill 紧跟 image（非 text 段，不触发补空格）。
    const segs: Segment[] = [
      { type: 'text', text: '看这张' },
      { type: 'image', id: 'img-x', path: '/tmp/x.png', fileName: 'x.png', displayName: 'x.png' },
      { type: 'skill', name: 'review' },
    ]
    expect(segmentsToText(segs)).toBe('看这张\n/tmp/x.png\n/skill:review')
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

  it('含 handoff segment 的 Segment[] 归一化正确', () => {
    const segs: Segment[] = [
      { type: 'handoff', sourceLabel: 'old-session' },
      { type: 'text', text: '请继续完成任务' },
    ]
    expect(normalizeContent(segs)).toBe('[handoff from old-session] 请继续完成任务')
  })

  it('纯 handoff segment（无 text）归一化正确', () => {
    const segs: Segment[] = [{ type: 'handoff', sourceLabel: 'src-abc' }]
    expect(normalizeContent(segs)).toBe('[handoff from src-abc]')
  })
})

describe('handoff segment', () => {
  it('handoff segment 序列化为 [handoff from sourceLabel]', () => {
    const segs: Segment[] = [{ type: 'handoff', sourceLabel: 'my-session' }]
    expect(segmentsToText(segs)).toBe('[handoff from my-session]')
  })

  it('handoff + text 混合时，handoff 标记后紧跟 text 补空格', () => {
    const segs: Segment[] = [
      { type: 'handoff', sourceLabel: 'src-session' },
      { type: 'text', text: '请继续完成以下任务' },
    ]
    expect(segmentsToText(segs)).toBe('[handoff from src-session] 请继续完成以下任务')
  })

  it('handoff segment 空 sourceLabel 不抛错', () => {
    const segs: Segment[] = [{ type: 'handoff', sourceLabel: '' }]
    expect(segmentsToText(segs)).toBe('[handoff from ]')
  })

  it('handoff + skill 混合不补空格（两者都是 chip 类但 handoff 已有 ] 分隔）', () => {
    const segs: Segment[] = [
      { type: 'handoff', sourceLabel: 'old-session' },
      { type: 'skill', name: 'review' },
    ]
    // handoff 结尾是 ]，skill 开头是 /，非 text→非 text 边界补空格
    expect(segmentsToText(segs)).toBe('[handoff from old-session] /skill:review')
  })
})
