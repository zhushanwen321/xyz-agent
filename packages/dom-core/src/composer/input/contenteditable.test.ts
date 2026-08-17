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
