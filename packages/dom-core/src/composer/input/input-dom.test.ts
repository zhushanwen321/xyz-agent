/**
 * input-dom.ts DOM 函数单测 —— composer input 模块 DOM 直连收敛层（W2 TC1）。
 *
 * 覆盖：getSegmentsFromEl（segment 状态机）/ getTextFromEl（br→\n）/ detectHashTriggerFromEl
 * （# 触发检测）/ findImageChipEl（dataset 遍历，CSS 特殊字符安全）。
 *
 * jsdom 支持 TreeWalker/Range/Selection；caretRangeFromPoint 未实现（moveCaretVertical
 * 多行分支不测，见 design review boundaryConditionNote）。
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/input-dom.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getSegmentsFromEl,
  getTextFromEl,
  detectHashTriggerFromEl,
  findImageChipEl,
  findImageChipElById,
  isSpacerNode,
} from './input-dom'

/** 构造 contenteditable div + 设 innerHTML */
function setupEl(html: string): HTMLDivElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

/** 构造 div 并挂到 document.body（jsdom Selection API 仅对 document 树内元素生效） */
function setupElInBody(html: string): HTMLDivElement {
  const el = setupEl(html)
  document.body.appendChild(el)
  return el
}

/** 设光标到指定文本节点的 offset 处（detectHashTrigger 测试用） */
function setCursor(targetNode: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(targetNode, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('getSegmentsFromEl', () => {
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })

  it('纯文本：产出单个 text segment', () => {
    const el = setupEl('hello world')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('<br> 产出 text segment 含 \\n（Shift+Enter 软换行保留）', () => {
    const el = setupEl('line1<br>line2')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'line1\nline2' }])
  })

  it('slash-chip（skill 类型）产出 skill segment（带 name + location）', () => {
    const el = setupEl(
      '<span class="slash-chip" data-chip-type="skill" data-chip-name="cw-cli" data-chip-location="/path"><span class="chip-label">cw-cli</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'skill', name: 'cw-cli', location: '/path' },
    ])
  })

  it('slash-chip（skill 无 location）产出 skill segment 无 location 字段', () => {
    const el = setupEl(
      '<span class="slash-chip" data-chip-type="skill" data-chip-name="myskill"><span class="chip-label">myskill</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'skill', name: 'myskill' }])
  })

  it('slash-chip（普通命令）把 chip-label 文本并入 text segment', () => {
    const el = setupEl(
      '<span class="slash-chip" data-chip-type="slash" data-chip-name="commit"><span class="chip-label">/commit</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: '/commit' }])
  })

  it('image-chip 产出 image segment（含 id/path/fileName/displayName/needsMigrate）', () => {
    const el = setupEl(
      '<span class="mention-chip mention-file image-chip" data-chip-type="image" data-chip-id="abc-123" data-chip-path="/tmp/x.png" data-chip-file-name="x.png" data-chip-display-name="截图.png" data-chip-needs-migrate="true"><span class="chip-label">截图.png</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      {
        type: 'image',
        id: 'abc-123',
        path: '/tmp/x.png',
        fileName: 'x.png',
        displayName: '截图.png',
        needsMigrate: true,
      },
    ])
  })

  it('image-chip 占位符（__paste_pending___）跳过不进 segments', () => {
    const el = setupEl(
      '<span class="image-chip" data-chip-type="image" data-chip-path="__paste_pending_550e8400-e29b-41d4-a716-446655440000__"><span class="chip-label">粘贴中...</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([])
  })

  it('mention-file chip 产出 file segment（带 lineRange）', () => {
    const el = setupEl(
      '<span class="mention-chip mention-file" data-chip-type="file" data-chip-path="/a.ts" data-chip-line-start="10" data-chip-line-end="20"><span class="chip-label">/a.ts:L10-L20</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'file', path: '/a.ts', lineRange: [10, 20] },
    ])
  })

  it('mention-file chip 无 lineRange 产出 file segment 无 lineRange 字段', () => {
    const el = setupEl(
      '<span class="mention-chip mention-file" data-chip-type="file" data-chip-path="/b.ts"><span class="chip-label">/b.ts</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'file', path: '/b.ts' }])
  })

  it('mixed：text + slash-chip + image-chip + br 组合正确分段', () => {
    const el = setupEl(
      '前缀 <span class="slash-chip" data-chip-type="skill" data-chip-name="s"><span class="chip-label">s</span></span> 中间<br>' +
        '<span class="image-chip" data-chip-type="image" data-chip-id="i1" data-chip-path="/p.png" data-chip-file-name="p.png" data-chip-display-name="p.png" data-chip-needs-migrate="false"><span class="chip-label">p.png</span></span> 后缀',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'text', text: '前缀 ' },
      { type: 'skill', name: 's' },
      { type: 'text', text: ' 中间\n' },
      {
        type: 'image',
        id: 'i1',
        path: '/p.png',
        fileName: 'p.png',
        displayName: 'p.png',
        needsMigrate: false,
      },
      { type: 'text', text: ' 后缀' },
    ])
  })

  it('chip-x（× 删除按钮）文本被过滤（TreeWalker 跳过 .chip-x 子树）', () => {
    const el = setupEl(
      '<span class="slash-chip" data-chip-type="slash" data-chip-name="c"><span class="chip-label">/c</span><span class="chip-x">×</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: '/c' }])
  })

  it('null el 返回空数组', () => {
    expect(getSegmentsFromEl(null)).toEqual([])
  })

  it('ZWSP (\\u200B) 从文本中删除，NBSP (\\u00A0) 转空格', () => {
    const el = setupEl('a\u200Bb\u00A0c')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'ab c' }])
  })
})

describe('getTextFromEl', () => {
  it('segmentsToText 便捷封装：br → \\n + chip 拍平', () => {
    const el = setupEl('hello<br>world')
    expect(getTextFromEl(el)).toBe('hello\nworld')
  })

  it('null el 返回空串', () => {
    expect(getTextFromEl(null)).toBe('')
  })
})

describe('detectHashTriggerFromEl', () => {
  let el: HTMLDivElement | null = null
  afterEach(() => {
    if (el && document.body.contains(el)) document.body.removeChild(el)
    el = null
  })

  it('光标在 #foo 后（行首）触发，返回 query=foo', () => {
    el = setupElInBody('#foo')
    const textNode = el.firstChild as Text
    setCursor(textNode, 4) // 光标在 "#foo" 末尾
    expect(detectHashTriggerFromEl(el)).toEqual({ query: 'foo' })
  })

  it('光标在 text #bar 后（空格后）触发，返回 query=bar', () => {
    el = setupElInBody('code #bar')
    const textNode = el.firstChild as Text
    setCursor(textNode, 9) // 光标在 "code #bar" 末尾
    expect(detectHashTriggerFromEl(el)).toEqual({ query: 'bar' })
  })

  it('光标前无 # 序列返回 null', () => {
    el = setupElInBody('plain text')
    const textNode = el.firstChild as Text
    setCursor(textNode, 5)
    expect(detectHashTriggerFromEl(el)).toBeNull()
  })

  it('选区非折叠（isCollapsed=false）返回 null', () => {
    el = setupElInBody('#foo')
    const textNode = el.firstChild as Text
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 4) // 非折叠选区
    sel?.addRange(range)
    expect(detectHashTriggerFromEl(el)).toBeNull()
  })

  it('null el 返回 null', () => {
    expect(detectHashTriggerFromEl(null)).toBeNull()
  })
})

describe('findImageChipEl / findImageChipElById', () => {
  it('按 chipPath 遍历定位（dataset 比对，含 CSS 特殊字符 path 安全）', () => {
    // 真实场景 path 含 " / ] 是经 JS dataset 赋值（不走 HTML 解析），模拟该路径
    const el = setupEl(
      '<span class="image-chip" data-chip-path="/normal.png"></span>' +
      '<span class="image-chip"></span>',
    )
    const chips = el.querySelectorAll<HTMLElement>('.image-chip')
    chips[1].dataset.chipPath = '/a"b]c.png'  // JS 赋值，特殊字符安全
    const found = findImageChipEl(el, '/a"b]c.png')
    expect(found).not.toBeNull()
    expect(found?.dataset.chipPath).toBe('/a"b]c.png')
  })

  it('path 不存在返回 null', () => {
    const el = setupEl('<span class="image-chip" data-chip-path="/x.png"></span>')
    expect(findImageChipEl(el, '/not-exist.png')).toBeNull()
  })

  it('按 chipId 遍历定位', () => {
    const el = setupEl(
      '<span class="image-chip" data-chip-id="id-1"></span><span class="image-chip" data-chip-id="id-2"></span>',
    )
    expect(findImageChipElById(el, 'id-2')?.dataset.chipId).toBe('id-2')
  })
})

describe('isSpacerNode', () => {
  it('NBSP 文本节点判为 spacer', () => {
    const n = document.createTextNode('\u00A0')
    expect(isSpacerNode(n)).toBe(true)
  })

  it('ZWSP 文本节点判为 spacer', () => {
    expect(isSpacerNode(document.createTextNode('\u200B'))).toBe(true)
  })

  it('普通文本节点非 spacer', () => {
    expect(isSpacerNode(document.createTextNode('hello'))).toBe(false)
  })

  it('null / element 节点非 spacer', () => {
    expect(isSpacerNode(null)).toBe(false)
    expect(isSpacerNode(document.createElement('span'))).toBe(false)
  })
})
