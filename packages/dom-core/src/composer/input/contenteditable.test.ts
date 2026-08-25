/**
 * contenteditable.ts composable 单测 —— composer input 模块 contenteditable 组合逻辑（W2 TC2）。
 *
 * 覆盖：onInput（slash/hash 触发检测）、paste 通路（pasteImage badge 回填 / text 降级）、
 * setText（caret start/end）、clear、syncEmpty、saveSelection/restoreSelection（savedRange 生命周期）。
 *
 * jsdom 限制：document.execCommand('insertText') 部分支持（paste 纯文本降级 / insertTextAtCursor
 * 不强测）；caretRangeFromPoint 未实现（moveCaretVertical 多行分支不测）。moveCaretVertical 单行
 * at-edge 分支可测。
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/contenteditable.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { useContenteditableInput } from './contenteditable'
import type { ContenteditableCallbacks } from './types'

/** mock callbacks 工厂（含 pasteImage） */
function makeCallbacks(overrides: Partial<ContenteditableCallbacks> = {}): ContenteditableCallbacks {
  return {
    onInput: vi.fn(),
    onSlashTrigger: vi.fn(),
    onFileTrigger: vi.fn(),
    onEnterKeydown: vi.fn(),
    onKeydown: vi.fn(),
    handleBackspaceOnChip: vi.fn(() => false),
    insertImageBadge: vi.fn(),
    getSessionId: vi.fn(() => 's1'),
    pasteImage: vi.fn(),
    ...overrides,
  }
}

/** setup：创建 el 挂 body + elRef + composable */
function setup(initialHtml = '', overrides: Partial<ContenteditableCallbacks> = {}) {
  // jsdom 未实现 document.execCommand（insertText/insertLineBreak），stub noop。
  // execCommand 的真实行为由 TC5 renderer 行为测试（happy-dom）覆盖，core 单测只验证编排逻辑。
  if (typeof document.execCommand !== 'function') {
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => false),
      configurable: true,
      writable: true,
    })
  }
  const el = document.createElement('div')
  el.innerHTML = initialHtml
  document.body.appendChild(el)
  const elRef = ref(el)
  const callbacks = makeCallbacks(overrides)
  const api = useContenteditableInput(elRef, callbacks)
  return { el, elRef, callbacks, ...api, cleanup: () => document.body.removeChild(el) }
}

describe('useContenteditableInput onInput 触发检测', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('slash 触发：/ 在最左且无 chip → onSlashTrigger({query})', () => {
    const c = setup('/goal')
    c.syncEmpty()
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith({ query: 'goal' })
    cleanup = c.cleanup
  })

  it('slash 不触发：不以 / 开头 → onSlashTrigger(null)', () => {
    const c = setup('hello')
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('slash 不触发：有 slash-chip → onSlashTrigger(null)（chip 文本不误触发）', () => {
    const c = setup('<span class="slash-chip" data-chip-type="slash"><span class="chip-label">/commit</span></span>')
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('hash 触发：光标在 #foo 后 → onFileTrigger({query})', () => {
    const c = setup('#foo')
    const textNode = c.el.firstChild as Text
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 4)
    range.collapse(true)
    sel?.addRange(range)
    c.onInput()
    expect(c.callbacks.onFileTrigger).toHaveBeenCalledWith({ query: 'foo' })
    cleanup = c.cleanup
  })

  it('hash 不触发：光标前无 # 序列 → onFileTrigger(null)', () => {
    const c = setup('plain')
    const textNode = c.el.firstChild as Text
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 3)
    range.collapse(true)
    sel?.addRange(range)
    c.onInput()
    expect(c.callbacks.onFileTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })
})

// ── 四符号体系 U1：$ / @ 触发 + bash 短路 + slash 正则化 ──

/** 把光标 collapse 到指定文本节点的 offset 处 */
function cursorAt(node: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('useContenteditableInput $ / @ 触发检测（onDollarFileTrigger / onSubagentTrigger）', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('$ 行首触发：光标在 $foo 后 → onDollarFileTrigger({query:"foo"})', () => {
    const c = setup('$foo', { onDollarFileTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 4)
    c.onInput()
    expect(c.callbacks.onDollarFileTrigger).toHaveBeenCalledWith({ query: 'foo' })
    cleanup = c.cleanup
  })

  it('$ 空格后触发：echo $HOME → {query:"HOME"}（登记取舍：非 bash 态照常触发）', () => {
    const c = setup('echo $HOME', { onDollarFileTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 10)
    c.onInput()
    expect(c.callbacks.onDollarFileTrigger).toHaveBeenCalledWith({ query: 'HOME' })
    cleanup = c.cleanup
  })

  it('$ 文字中间不触发：a$b → onDollarFileTrigger(null)', () => {
    const c = setup('a$b', { onDollarFileTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 3)
    c.onInput()
    expect(c.callbacks.onDollarFileTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('@ 空格后触发：hey @build → onSubagentTrigger({query:"build"})', () => {
    const c = setup('hey @build', { onSubagentTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 10)
    c.onInput()
    expect(c.callbacks.onSubagentTrigger).toHaveBeenCalledWith({ query: 'build' })
    cleanup = c.cleanup
  })

  it('@ 文字中间不触发：a@b → onSubagentTrigger(null)', () => {
    const c = setup('a@b', { onSubagentTrigger: vi.fn() })
    cursorAt(c.el.firstChild as Text, 3)
    c.onInput()
    expect(c.callbacks.onSubagentTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('壳层未注入新回调（可选）时不抛错（ui ComposerInput 接线前形态）', () => {
    const c = setup('$foo')
    cursorAt(c.el.firstChild as Text, 4)
    expect(() => c.onInput()).not.toThrow()
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput bash 豁免短路（shouldSuppressTriggers）', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('suppress=true：所有 trigger 回调收 null（含可选两路），不做检测', () => {
    const c = setup('#foo', {
      shouldSuppressTriggers: () => true,
      onDollarFileTrigger: vi.fn(),
      onSubagentTrigger: vi.fn(),
    })
    cursorAt(c.el.firstChild as Text, 4) // #foo 光标末尾——非 bash 态本应触发 file
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    expect(c.callbacks.onFileTrigger).toHaveBeenCalledWith(null)
    expect(c.callbacks.onDollarFileTrigger).toHaveBeenCalledWith(null)
    expect(c.callbacks.onSubagentTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('suppress=true：draft 同步不受影响（onInput 照发文本）', () => {
    const c = setup('!echo $HOME', { shouldSuppressTriggers: () => true })
    c.onInput()
    expect(c.callbacks.onInput).toHaveBeenCalledWith('!echo $HOME')
    cleanup = c.cleanup
  })

  it('suppress=false：行为与未注入一致（# 触发照常）', () => {
    const c = setup('#foo', { shouldSuppressTriggers: () => false })
    cursorAt(c.el.firstChild as Text, 4)
    c.onInput()
    expect(c.callbacks.onFileTrigger).toHaveBeenCalledWith({ query: 'foo' })
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput slash 正则化（D5：光标所在行行首）', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('多行第二行行首 / 触发（行为放宽，对齐 TUI）', () => {
    // Shift+Enter 产 <br> 分行：line1<br>/compact，光标在第二文本节点末尾
    const c = setup('line1<br>/compact')
    const secondTextNode = c.el.childNodes[2] as Text
    cursorAt(secondTextNode, 8)
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith({ query: 'compact' })
    cleanup = c.cleanup
  })

  it('光标在行首但 / 前有文字（帮我 /x）→ null（空格后不触发）', () => {
    const c = setup('帮我 /x')
    cursorAt(c.el.firstChild as Text, 5)
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('多行第一行行首 /：光标在第二行 → null（不被第一行误触发）', () => {
    const c = setup('/cmd<br>正文')
    const secondTextNode = c.el.childNodes[2] as Text
    cursorAt(secondTextNode, 2)
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })

  it('无光标兜底：程序化 input（无选区）回退旧 startsWith 行为', () => {
    // renderer 集成测试形态：设 innerHTML + trigger('input')，无光标选区
    const c = setup('/commit')
    window.getSelection()?.removeAllRanges()
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith({ query: 'commit' })
    cleanup = c.cleanup
  })

  it('有 chip 时不触发（hasChip 语义保留，旧回归）', () => {
    const c = setup('<span class="slash-chip"><span class="chip-label">/old</span></span>/new')
    cursorAt(c.el.lastChild as Text, 4)
    c.onInput()
    expect(c.callbacks.onSlashTrigger).toHaveBeenCalledWith(null)
    cleanup = c.cleanup
  })
})

/** 构造 mock ClipboardEvent（jsdom 无 DataTransfer 全局，用 mock 对象） */
function makePasteEvent(opts: { imageFile?: File; text?: string }): ClipboardEvent {
  const items = opts.imageFile ? [{ kind: 'file' as const, type: opts.imageFile.type, getAsFile: () => opts.imageFile! }] : []
  const clipboardData = {
    items,
    getData: (type: string) => (type === 'text/plain' ? opts.text ?? '' : ''),
  }
  return { preventDefault: () => {}, clipboardData } as unknown as ClipboardEvent
}

describe('useContenteditableInput paste 通路（pasteImage 注入）', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('paste image → badge：占位插入 + pasteImage resolve 后调用', async () => {
    const c = setup('', {
      pasteImage: vi.fn().mockResolvedValue({
        kind: 'badge',
        path: '/real/a.png',
        fileName: 'a-uuid.png',
        displayName: '截图-a.png',
        needsMigrate: true,
      }),
    })
    const file = new File(['img'], 'a.png', { type: 'image/png' })
    c.onPaste(makePasteEvent({ imageFile: file }))
    expect(c.callbacks.insertImageBadge).toHaveBeenCalledWith(
      expect.stringMatching(/^__paste_pending_[0-9a-f-]+__$/),
      expect.stringMatching(/^__paste_pending_[0-9a-f-]+__$/),
      '粘贴中...',
      false,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(c.callbacks.pasteImage).toHaveBeenCalledWith(file, 's1')
    cleanup = c.cleanup
  })

  it('paste image → text 降级：pasteImage resolve kind:text 触发', async () => {
    const c = setup('', {
      pasteImage: vi.fn().mockResolvedValue({ kind: 'text', text: '[降级文本]' }),
    })
    const file = new File(['img'], 'b.png', { type: 'image/png' })
    c.onPaste(makePasteEvent({ imageFile: file }))
    await new Promise((r) => setTimeout(r, 0))
    expect(c.callbacks.pasteImage).toHaveBeenCalledWith(file, 's1')
    cleanup = c.cleanup
  })

  it('paste 无 image item（纯文本）→ 不调 pasteImage，走纯文本通路', () => {
    const c = setup('初始')
    c.onPaste(makePasteEvent({ text: '纯文本内容' }))
    expect(c.callbacks.pasteImage).not.toHaveBeenCalled()
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput setText / clear / syncEmpty', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('setText 写入纯文本 + emitInput(text) + isEmpty=false', () => {
    const c = setup('')
    c.setText('hello')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('hello')
    expect(c.isEmpty.value).toBe(false)
    expect(c.el.textContent).toBe('hello')
    cleanup = c.cleanup
  })

  it('setText 含 \\n → 用 <br> 分隔文本节点', () => {
    const c = setup('')
    c.setText('line1\nline2')
    expect(c.el.innerHTML).toBe('line1<br>line2')
    cleanup = c.cleanup
  })

  it('clear 清空 + emitInput("") + isEmpty=true', () => {
    const c = setup('content')
    c.clear()
    expect(c.el.textContent).toBe('')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('')
    expect(c.isEmpty.value).toBe(true)
    cleanup = c.cleanup
  })

  it('syncEmpty：空内容 → isEmpty=true；非空 → false', () => {
    const c = setup('')
    c.syncEmpty()
    expect(c.isEmpty.value).toBe(true)
    c.el.textContent = 'x'
    c.syncEmpty()
    expect(c.isEmpty.value).toBe(false)
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput saveSelection / restoreSelection', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('saveSelection 记录选区，restoreSelection 恢复', () => {
    const c = setup('hello')
    document.body.appendChild(c.el) // setup 已挂，确保在 body
    const textNode = c.el.firstChild as Text
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.setEnd(textNode, 3)
    sel?.addRange(range)
    c.saveSelection()
    // 改变选区（模拟夺焦）
    sel?.removeAllRanges()
    // restore
    c.restoreSelection()
    const after = window.getSelection()
    expect(after?.rangeCount).toBeGreaterThan(0)
    cleanup = c.cleanup
  })

  it('clear 后 restoreSelection 不恢复 stale range（savedRange=null，仅 focus）', () => {
    const c = setup('hello')
    const textNode = c.el.firstChild as Text
    const sel = window.getSelection()
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.collapse(true)
    sel?.addRange(range)
    c.saveSelection()
    c.clear() // savedRange 置 null
    // restore 不抛错（focus 兜底，不 addRange stale）
    expect(() => c.restoreSelection()).not.toThrow()
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput moveCaretVertical（jsdom 单行 at-edge）', () => {
  let cleanup: () => void
  afterEach(() => {
    cleanup?.()
  })

  it('单行内容 at-edge：moveCaretVertical 返回 at-edge', () => {
    const c = setup('only line')
    const result = c.moveCaretVertical('up')
    expect(result).toBe('at-edge')
    cleanup = c.cleanup
  })
})

describe('useContenteditableInput clear 族（boundaryLen 模式：只删「符号+query 到光标」段）', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('clearSlashQueryText 新行为：只删行首 /query 段，不再全清输入框（D5 修正）', () => {
    const c = setup('/commit')
    cursorAt(c.el.firstChild as Text, 7)
    c.clearSlashQueryText()
    expect(c.getText()).toBe('')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('')
    cleanup = c.cleanup
  })

  it('clearSlashQueryText：多行草稿只删 /query 行内容，其他行保留', () => {
    const c = setup('line1<br>/compact')
    const secondTextNode = c.el.childNodes[2] as Text
    cursorAt(secondTextNode, 8)
    c.clearSlashQueryText()
    // 第一行与 <br> 分行保留，第二行 /compact 被删
    expect(c.getText()).toBe('line1\n')
    cleanup = c.cleanup
  })

  it('clearSlashQueryText：光标不在行首 /query 后（不匹配）→ 不动作', () => {
    const c = setup('hello')
    cursorAt(c.el.firstChild as Text, 5)
    c.clearSlashQueryText()
    expect(c.getText()).toBe('hello')
    // 不匹配时不 emitInput（无变更）
    expect(c.callbacks.onInput).not.toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('clearHashQueryText 行为不变（回归）：只删 #query 段，边界空格保留', () => {
    const c = setup('see #quer')
    cursorAt(c.el.firstChild as Text, 9)
    c.clearHashQueryText()
    expect(c.getText()).toBe('see ')
    cleanup = c.cleanup
  })

  it('clearDollarFileQueryText：只删 $query 段，边界空格保留', () => {
    const c = setup('see $quer')
    cursorAt(c.el.firstChild as Text, 9)
    c.clearDollarFileQueryText()
    expect(c.getText()).toBe('see ')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('see ')
    cleanup = c.cleanup
  })

  it('clearSubagentQueryText：只删 @query 段，边界空格保留', () => {
    const c = setup('hey @build')
    cursorAt(c.el.firstChild as Text, 10)
    c.clearSubagentQueryText()
    expect(c.getText()).toBe('hey ')
    expect(c.callbacks.onInput).toHaveBeenCalledWith('hey ')
    cleanup = c.cleanup
  })

  it('clearDollarFileQueryText：无光标时不动作（不抛错）', () => {
    const c = setup('see $quer')
    window.getSelection()?.removeAllRanges()
    expect(() => c.clearDollarFileQueryText()).not.toThrow()
    expect(c.getText()).toBe('see $quer')
    cleanup = c.cleanup
  })
})
