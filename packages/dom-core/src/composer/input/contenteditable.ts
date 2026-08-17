/**
 * composer contenteditable 输入组合逻辑 —— core/domain/composer/input/contenteditable.ts（W2）。
 *
 * 定位：迁自 renderer useContenteditableInput.ts（873 行）的 composable 部分。
 * 职责（单一变化轴「contenteditable 输入事件 + 文本/光标操作」）：
 * - getText/getSegments：TreeWalker 文本提取（委托 input-dom.ts）
 * - syncEmpty/detectHashTrigger：空态判定与 # 文件触发检测
 * - scrollCursorIntoView：Shift+Enter 后光标滚动进可见区
 * - saveSelection/restoreSelection：命令浮层夺焦前后保存/恢复光标
 * - clearSlashQueryText/clearHashQueryText：清过滤文本
 * - clear/setText/insertTextAtCursor：程序化整框写入
 * - onInput/onKeydown/onCompositionEnd/onPaste：输入事件处理（IME/Shift+Enter/paste 富呈现）
 * - moveCaretVertical：视觉行上下移动（委托 input-dom）
 *
 * [W2 改造] handleImagePasteEvent 原直接 import handleImagePaste（走 IPC），现改经 callbacks.pasteImage
 * 注入（clarify C1 D1），core 不再 import useImageAttachment。paste 通路（占位 badge 插入 +
 * 异步回填/降级编排）保留，仅 IPC 调用上移壳层。
 *
 * 行为约定（byte-for-byte 与原 useContenteditableInput 一致，CRITICAL）：
 * - IME 组合中（composing.value / e.isComposing）不拦截 Enter
 * - Shift+Enter → insertLineBreak + onInput + scrollCursorIntoView
 * - Enter（无 shift）→ emit('keydown', e)
 */
import { ref, type Ref } from 'vue'
import type { Segment } from '@xyz-agent/shared'
import {
  getSegmentsFromEl,
  getTextFromEl,
  detectHashTriggerFromEl,
  getCaretLineRect,
  moveCaretVerticalOf,
  pickClipboardImageItem,
  findImageChipEl,
  applyImagePersistResult,
} from './input-dom'
import type { ContenteditableCallbacks, HandleImagePasteResult } from './types'

/**
 * Cmd/Ctrl+V 富呈现通路处理（原 useContenteditableInput 模块级私有，改接收 pasteImage）。
 *
 * 异步间隙（TO1）：先插占位 badge「粘贴中...」，await pasteImage 后回填真实 path/name；
 * 失败（IPC throw / 非 electron undefined / 读 blob 失败 → kind:'text'）移除占位 + insertText 降级。
 *
 * @param pasteImage 壳层注入的图片持久化回调（替代直接 import handleImagePaste）
 * @returns true 表示已接管（走 image 通路），false 表示无 image item（onPaste 回退纯文本通路）
 */
function handleImagePasteEvent(
  e: ClipboardEvent,
  deps: {
    getEl: () => HTMLDivElement | null
    insertImageBadge: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void
    onInput: () => void
    getSessionId: () => string | null
    pasteImage: (file: File, sessionId: string | null) => Promise<HandleImagePasteResult>
  },
): boolean {
  const imageItem = pickClipboardImageItem(e)
  const file = imageItem?.getAsFile()
  if (!file) return false
  const placeholderMark = `__paste_pending_${crypto.randomUUID()}__`
  deps.insertImageBadge(placeholderMark, placeholderMark, '粘贴中...', false)
  const sessionId = deps.getSessionId()
  void (async () => {
    const result = await deps.pasteImage(file, sessionId)
    const el = deps.getEl()
    const placeholder = el ? findImageChipEl(el, placeholderMark) : null
    applyImagePersistResult({
      placeholderEl: placeholder,
      result,
      insertImageBadge: deps.insertImageBadge,
    })
    deps.onInput()
  })()
  return true
}

/**
 * @param elRef contenteditable 根元素 ref
 * @param callbacks 触发事件 + Backspace-chip 删除委派 + pasteImage 注入
 */
export function useContenteditableInput(
  elRef: Ref<HTMLDivElement | null>,
  callbacks: ContenteditableCallbacks,
): {
  composing: Ref<boolean>
  isEmpty: Ref<boolean>
  onInput: () => void
  onKeydown: (e: KeyboardEvent) => void
  onCompositionEnd: () => void
  onPaste: (e: ClipboardEvent) => void
  syncEmpty: () => void
  getText: () => string
  getSegments: () => Segment[]
  saveSelection: () => void
  restoreSelection: () => void
  clearSlashQueryText: () => void
  clearHashQueryText: () => void
  clear: () => void
  setText: (text: string, caretPosition?: 'start' | 'end') => void
  insertTextAtCursor: (text: string) => void
  moveCaretVertical: (dir: 'up' | 'down') => 'moved' | 'at-edge'
} {
  const {
    onInput: emitInput,
    onSlashTrigger,
    onFileTrigger,
    onEnterKeydown,
    onKeydown: forwardKeydown,
    handleBackspaceOnChip,
    insertImageBadge,
    getSessionId,
    pasteImage,
  } = callbacks

  const composing = ref(false)
  const isEmpty = ref(true)
  let savedRange: Range | null = null
  let preferredCaretX: number | null = null

  function getEl(): HTMLDivElement | null {
    return elRef.value
  }

  function getText(): string {
    return getTextFromEl(getEl())
  }

  function getSegments(): Segment[] {
    return getSegmentsFromEl(getEl())
  }

  function syncEmpty(): void {
    isEmpty.value = getText().trim() === ''
  }

  function detectHashTrigger(): { query: string } | null {
    return detectHashTriggerFromEl(getEl())
  }

  function onInput(): void {
    syncEmpty()
    const text = getText()
    emitInput(text)
    preferredCaretX = null
    const hasChip = !!getEl()?.querySelector('.slash-chip, .mention-chip')
    onSlashTrigger(!hasChip && text.startsWith('/') ? { query: text.slice(1) } : null)
    onFileTrigger(detectHashTrigger())
  }

  function onCompositionEnd(): void {
    composing.value = false
    onInput()
  }

  function scrollCursorIntoView(): void {
    const el = getEl()
    if (!el) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return
    const range = sel.getRangeAt(0).cloneRange()
    const caretRect = getCaretLineRect(range)
    if (!caretRect) return
    const elRect = el.getBoundingClientRect()
    if (caretRect.bottom > elRect.bottom) {
      el.scrollTop += caretRect.bottom - elRect.bottom
    } else if (caretRect.top < elRect.top) {
      el.scrollTop -= elRect.top - caretRect.top
    }
  }

  function moveCaretVertical(dir: 'up' | 'down'): 'moved' | 'at-edge' {
    const el = getEl()
    if (!el) return 'at-edge'
    const { result, preferredX } = moveCaretVerticalOf(el, dir, preferredCaretX)
    preferredCaretX = preferredX
    return result
  }

  function onKeydown(e: KeyboardEvent): void {
    if (composing.value || e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        document.execCommand('insertLineBreak')
        onInput()
        scrollCursorIntoView()
        return
      }
      onEnterKeydown(e)
      return
    }
    if (e.key === 'Backspace' && handleBackspaceOnChip()) {
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      preferredCaretX = null
    }
    forwardKeydown(e)
  }

  function onPaste(e: ClipboardEvent): void {
    e.preventDefault()
    if (handleImagePasteEvent(e, { getEl, insertImageBadge, onInput, getSessionId, pasteImage })) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    document.execCommand('insertText', false, text)
    onInput()
  }

  function saveSelection(): void {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && elRef.value?.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange()
    }
    preferredCaretX = null
  }

  function restoreSelection(): void {
    const el = getEl()
    if (!el) return
    if (!savedRange) {
      el.focus()
      return
    }
    el.focus()
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(savedRange)
    }
  }

  function clearSlashQueryText(): void {
    const el = getEl()
    if (!el) return
    el.textContent = ''
    savedRange = null
    syncEmpty()
    emitInput('')
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  function clearHashQueryText(): void {
    const el = getEl()
    if (!el) return
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return
    const node = sel.anchorNode
    if (!node || !el.contains(node)) return
    if (node.nodeType !== Node.TEXT_NODE) return
    const offset = sel.anchorOffset
    const text = node.textContent ?? ''
    const beforeCursor = text.slice(0, offset)
    const m = /(?:^|\s)#(\S*)$/.exec(beforeCursor)
    if (!m) return
    const boundaryLen = m[0].length - 1 - m[1].length
    const hashStart = (m.index ?? 0) + boundaryLen
    const range = document.createRange()
    range.setStart(node, hashStart)
    range.setEnd(node, offset)
    range.deleteContents()
    sel.removeAllRanges()
    sel.addRange(range)
    syncEmpty()
    emitInput(getText())
  }

  function clear(): void {
    const el = getEl()
    if (!el) return
    el.textContent = ''
    savedRange = null
    preferredCaretX = null
    syncEmpty()
    emitInput('')
  }

  function insertTextAtCursor(text: string): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    document.execCommand('insertText', false, text)
    onInput()
  }

  function setText(text: string, caretPosition: 'start' | 'end' = 'end'): void {
    const el = getEl()
    if (!el) return
    preferredCaretX = null
    el.replaceChildren()
    const parts = text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) el.appendChild(document.createElement('br'))
      if (parts[i]) el.appendChild(document.createTextNode(parts[i]))
    }
    savedRange = null
    el.focus()
    const range = document.createRange()
    if (caretPosition === 'start') {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const firstText = walker.nextNode()
      if (firstText) {
        range.setStart(firstText, 0)
        range.collapse(true)
      } else {
        range.selectNodeContents(el)
        range.collapse(true)
      }
    } else {
      let lastText: Text | null = null
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) lastText = walker.currentNode as Text
      if (lastText) {
        range.setStart(lastText, lastText.length)
        range.collapse(true)
      } else {
        range.selectNodeContents(el)
        range.collapse(false)
      }
    }
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    syncEmpty()
    emitInput(text)
  }

  return {
    composing,
    isEmpty,
    onInput,
    onKeydown,
    onCompositionEnd,
    onPaste,
    syncEmpty,
    getText,
    getSegments,
    saveSelection,
    restoreSelection,
    clearSlashQueryText,
    clearHashQueryText,
    clear,
    setText,
    insertTextAtCursor,
    moveCaretVertical,
  }
}
