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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getSegmentsFromEl,
  getTextFromEl,
  detectHashTriggerFromEl,
  detectFileDollarTriggerFromEl,
  detectSubagentTriggerFromEl,
  detectSlashTriggerFromEl,
  findImageChipEl,
  findImageChipElById,
  isSpacerNode,
  applyImagePersistResult,
  CHIP_SPACER_ZWSP,
} from './input-dom'
import type { HandleImagePasteResult } from './types'

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

  it('块级 div 分行产出 \\n（粘贴 insertText 的 Chromium 形态，换行不丢）', () => {
    // execCommand('insertText') 含 \n 文本在 Chromium 的实际产出形态（实测 innerHTML）
    const el = setupEl('line1<div>line2</div><div>line3</div>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'line1\nline2\nline3' }])
  })

  it('首行即块级 div：首块前不产出多余换行', () => {
    const el = setupEl('<div>a</div><div>b</div>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'a\nb' }])
  })

  it('块级 div 内 <br> 空行：与块级边界换行去重（一个空行一个 \\n）', () => {
    const el = setupEl('a<div><br></div>b')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'a\n\nb' }])
  })

  it('块级 div 后跟顶层文本：块结束也补 \\n（视觉在下一行）', () => {
    const el = setupEl('abcx<div>y</div>def')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'abcx\ny\ndef' }])
  })

  it('块级 p 分行同样产出 \\n', () => {
    const el = setupEl('<p>one</p><p>two</p>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: 'one\ntwo' }])
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

  it('session chip（dataset.chipType=session）产出 session segment（sessionId + label）', () => {
    const el = setupEl(
      '<span class="mention-chip mention-session" data-chip-type="session" data-chip-session-id="019e-abc" data-chip-label="设计讨论"><span class="chip-label">设计讨论</span><span class="chip-x">×</span></span>',
    )
    // × 按钮文本不进 segment（rejectChips 跳过子树）
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'session', sessionId: '019e-abc', label: '设计讨论' },
    ])
  })

  it('subagent chip（dataset.chipType=subagent）产出 subagent segment（subagentId + slug）', () => {
    const el = setupEl(
      '<span class="mention-chip mention-at" data-chip-type="subagent" data-chip-subagent-id="sub-1" data-chip-slug="build-api"><span class="chip-label">@build-api</span><span class="chip-x">×</span></span>',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'subagent', subagentId: 'sub-1', slug: 'build-api' },
    ])
  })

  it('旧 mention-at chip（无 dataset）保持文本拍平（历史消息编辑兼容，F3）', () => {
    const el = setupEl('<span class="mention-chip mention-at">@alice</span>')
    expect(getSegmentsFromEl(el)).toEqual([{ type: 'text', text: '@alice' }])
  })

  it('session chip 与文本混合：前后文本正确分段', () => {
    const el = setupEl(
      '看看 <span class="mention-chip mention-session" data-chip-type="session" data-chip-session-id="s1" data-chip-label="会话 A"><span class="chip-label">会话 A</span></span> 的内容',
    )
    expect(getSegmentsFromEl(el)).toEqual([
      { type: 'text', text: '看看 ' },
      { type: 'session', sessionId: 's1', label: '会话 A' },
      { type: 'text', text: ' 的内容' },
    ])
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

describe('detectFileDollarTriggerFromEl（$ 文件触发）', () => {
  let el: HTMLDivElement | null = null
  afterEach(() => {
    if (el && document.body.contains(el)) document.body.removeChild(el)
    el = null
  })

  /** 便捷：设 innerHTML + 光标定位到第 idx 个文本节点末尾（默认 0） */
  function setupWithCursor(html: string): HTMLDivElement {
    el = setupElInBody(html)
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const textNode = walker.nextNode() as Text
    setCursor(textNode, textNode.length)
    return el
  }

  it('行首 $foo 触发，query=foo', () => {
    setupWithCursor('$foo')
    expect(detectFileDollarTriggerFromEl(el)).toEqual({ query: 'foo' })
  })

  it('空格后 $foo 触发（look at $foo）', () => {
    setupWithCursor('look at $foo')
    expect(detectFileDollarTriggerFromEl(el)).toEqual({ query: 'foo' })
  })

  it('$HOME 在普通文本触发（登记取舍：非 bash 态 $ 变量文本会弹层，设计 D6）', () => {
    // 用户输入 ` $HOME` 时光标在 HOME 后——非 bash 态照常触发（无豁免机制的固有噪声）
    setupWithCursor('看看 $HOME')
    expect(detectFileDollarTriggerFromEl(el)).toEqual({ query: 'HOME' })
  })

  it('裸 $ 触发（query 空串，浮层刚弹出态）', () => {
    setupWithCursor('see $')
    expect(detectFileDollarTriggerFromEl(el)).toEqual({ query: '' })
  })

  it('文字中间 a$b 不触发（$ 前非空格/行首）', () => {
    setupWithCursor('a$b')
    expect(detectFileDollarTriggerFromEl(el)).toBeNull()
  })

  it('$ 后遇空格终止（$foo bar → null）', () => {
    setupWithCursor('$foo bar')
    expect(detectFileDollarTriggerFromEl(el)).toBeNull()
  })

  it('null el 返回 null', () => {
    expect(detectFileDollarTriggerFromEl(null)).toBeNull()
  })
})

describe('detectSubagentTriggerFromEl（@ subagent 触发）', () => {
  let el: HTMLDivElement | null = null
  afterEach(() => {
    if (el && document.body.contains(el)) document.body.removeChild(el)
    el = null
  })

  it('行首 @build 触发，query=build', () => {
    el = setupElInBody('@build')
    const textNode = el.firstChild as Text
    setCursor(textNode, 6)
    expect(detectSubagentTriggerFromEl(el)).toEqual({ query: 'build' })
  })

  it('空格后 @build 触发（hey @build-api）', () => {
    el = setupElInBody('hey @build-api')
    const textNode = el.firstChild as Text
    setCursor(textNode, 14)
    expect(detectSubagentTriggerFromEl(el)).toEqual({ query: 'build-api' })
  })

  it('文字中间 a@b 不触发', () => {
    el = setupElInBody('a@b')
    const textNode = el.firstChild as Text
    setCursor(textNode, 3)
    expect(detectSubagentTriggerFromEl(el)).toBeNull()
  })

  it('@ 后遇空格终止（@x y → null）', () => {
    el = setupElInBody('@x y')
    const textNode = el.firstChild as Text
    setCursor(textNode, 4)
    expect(detectSubagentTriggerFromEl(el)).toBeNull()
  })

  it('null el 返回 null', () => {
    expect(detectSubagentTriggerFromEl(null)).toBeNull()
  })
})

describe('detectSlashTriggerFromEl（行首 slash 触发，D5 正则化）', () => {
  let el: HTMLDivElement | null = null
  afterEach(() => {
    if (el && document.body.contains(el)) document.body.removeChild(el)
    el = null
  })

  it('行首 /compact 触发，query=compact', () => {
    el = setupElInBody('/compact')
    const textNode = el.firstChild as Text
    setCursor(textNode, 8)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'compact' })
  })

  it('裸 / 触发（query 空串）', () => {
    el = setupElInBody('/')
    const textNode = el.firstChild as Text
    setCursor(textNode, 1)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: '' })
  })

  it('多行第二行行首 / 触发（<br> 分行形态，行为放宽对齐 TUI）', () => {
    el = setupElInBody('line1<br>/compact')
    // 第二个文本节点（/compact），光标置其末尾
    const textNode = el.childNodes[2] as Text
    setCursor(textNode, 8)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'compact' })
  })

  it('文本节点内 \\n 后行首 / 触发（防御：粘贴还原的罕见单节点形态）', () => {
    el = setupElInBody('line1\n/compact')
    const textNode = el.firstChild as Text
    setCursor(textNode, 14)
    expect(detectSlashTriggerFromEl(el)).toEqual({ query: 'compact' })
  })

  it('空格后 / 不触发（帮我看看 /usr/local——路径文本高频，D5 否决空格触发）', () => {
    el = setupElInBody('帮我看看 /usr/local')
    const textNode = el.firstChild as Text
    setCursor(textNode, textNode.length)
    expect(detectSlashTriggerFromEl(el)).toBeNull()
  })

  it('行中段 foo/ 不触发', () => {
    el = setupElInBody('foo/')
    const textNode = el.firstChild as Text
    setCursor(textNode, 4)
    expect(detectSlashTriggerFromEl(el)).toBeNull()
  })

  it('query 后输入空格终止（/compact 详细 → null）', () => {
    el = setupElInBody('/compact 详细')
    const textNode = el.firstChild as Text
    setCursor(textNode, 11)
    expect(detectSlashTriggerFromEl(el)).toBeNull()
  })

  it('null el 返回 null', () => {
    expect(detectSlashTriggerFromEl(null)).toBeNull()
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

describe('applyImagePersistResult', () => {
  let execSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // jsdom 未实现 document.execCommand，手动挂 spy（applyImagePersistResult 的 text 分支会调）
    execSpy = vi.fn().mockReturnValue(false)
    Object.defineProperty(document, 'execCommand', {
      value: execSpy,
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    // 清理测试注入的 execCommand，避免污染其他测试
    delete (document as { execCommand?: unknown }).execCommand
  })

  /** 构造一个带 .chip-label 子元素的占位 badge 元素 */
  function makePlaceholder(labelText = '粘贴中...'): HTMLElement {
    const placeholder = document.createElement('div')
    placeholder.classList.add('image-chip')
    const label = document.createElement('span')
    label.classList.add('chip-label')
    label.textContent = labelText
    placeholder.appendChild(label)
    return placeholder
  }

  it('kind=badge + placeholderEl 存在：回填 dataset + 更新 label，不调 insertImageBadge', () => {
    const placeholder = makePlaceholder('粘贴中...')
    const insertImageBadge = vi.fn()
    const result: HandleImagePasteResult = {
      kind: 'badge',
      path: '/tmp/abc.png',
      fileName: 'abc.png',
      displayName: '图片.png',
      needsMigrate: true,
    }

    applyImagePersistResult({ placeholderEl: placeholder, result, insertImageBadge })

    expect(placeholder.dataset.chipPath).toBe('/tmp/abc.png')
    expect(placeholder.dataset.chipFileName).toBe('abc.png')
    expect(placeholder.dataset.chipDisplayName).toBe('图片.png')
    expect(placeholder.dataset.chipNeedsMigrate).toBe('true')
    expect(placeholder.querySelector('.chip-label')?.textContent).toBe('图片.png')
    expect(insertImageBadge).not.toHaveBeenCalled()
  })

  it('kind=badge + placeholderEl 为 null：调 insertImageBadge 一次，参数 = result 各字段', () => {
    const insertImageBadge = vi.fn()
    const result: HandleImagePasteResult = {
      kind: 'badge',
      path: '/p/x.png',
      fileName: 'x.png',
      displayName: 'x.png',
      needsMigrate: false,
    }

    applyImagePersistResult({ placeholderEl: null, result, insertImageBadge })

    expect(insertImageBadge).toHaveBeenCalledTimes(1)
    expect(insertImageBadge).toHaveBeenCalledWith('/p/x.png', 'x.png', 'x.png', false)
  })

  it('kind=text + placeholderEl 存在 + nextSibling 是 ZWSP 文本节点：移除 nextSibling + placeholder + 调 execCommand', () => {
    const placeholder = makePlaceholder()
    const zwsp = document.createTextNode(CHIP_SPACER_ZWSP)
    const parent = document.createElement('div')
    parent.appendChild(placeholder)
    parent.appendChild(zwsp)

    const insertImageBadge = vi.fn()
    const result: HandleImagePasteResult = { kind: 'text', text: 'fallback text' }

    applyImagePersistResult({ placeholderEl: placeholder, result, insertImageBadge })

    expect(parent.contains(placeholder)).toBe(false)
    expect(parent.contains(zwsp)).toBe(false)
    expect(execSpy).toHaveBeenCalledWith('insertText', false, 'fallback text')
    expect(insertImageBadge).not.toHaveBeenCalled()
  })

  it('kind=text + placeholderEl 存在 + nextSibling 非 ZWSP：只移除 placeholder，nextSibling 不动 + 调 execCommand', () => {
    const placeholder = makePlaceholder()
    const other = document.createTextNode('普通文本')
    const parent = document.createElement('div')
    parent.appendChild(placeholder)
    parent.appendChild(other)

    const insertImageBadge = vi.fn()
    const result: HandleImagePasteResult = { kind: 'text', text: 't' }

    applyImagePersistResult({ placeholderEl: placeholder, result, insertImageBadge })

    expect(parent.contains(placeholder)).toBe(false)
    expect(parent.contains(other)).toBe(true)
    expect(execSpy).toHaveBeenCalledWith('insertText', false, 't')
    expect(insertImageBadge).not.toHaveBeenCalled()
  })
})
