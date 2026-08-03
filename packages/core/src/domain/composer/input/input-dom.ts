/**
 * composer input 模块 DOM 直连收敛层 —— core/domain/composer/input/ 的 DOM 适配单一出口（W2）。
 *
 * 定位：slice design review TC1 落地——useContenteditableInput（873 行）+ useComposerChipCommands
 * 中所有 DOM 直连（document./window./Range/Selection/TreeWalker/getClientRects/caretRangeFromPoint）
 * 收敛到此文件的纯函数。其余 input composable（contenteditable/chip-commands/dragdrop）委托本文件，
 * 不再散布 DOM 直连。
 *
 * 来源：
 * - useContenteditableInput.ts 模块级函数：getSegmentsFromEl/getTextFromEl/detectHashTriggerFromEl/
 *   getCaretLineRect/getVisualLineRects/moveCaretVerticalOf/pickClipboardImageItem
 * - useComposerChipCommands.ts 模块级 DOM 辅助：findImageChipEl/findImageChipElById/isSpacerNode/
 *   placeCursorAfter/removeChipNode（重构为接收 onChanged 的纯函数）
 *
 * 零 renderer import：仅依赖 @xyz-agent/shared（segmentsToText/Segment）+ 浏览器 DOM API。
 * core 运行在渲染进程，DOM 类型来自 TypeScript 默认 DOM lib（core tsconfig 未排除 DOM lib）。
 *
 * 测试环境：jsdom 支持 TreeWalker/Range/getClientRects（caretRangeFromPoint 除外，多行分支
 * 由 renderer 行为测试兜底，详见 design review boundaryConditionNote）。
 */
import { segmentsToText } from '@xyz-agent/shared'
import type { Segment } from '@xyz-agent/shared'
import type { VerticalMoveResult } from './types'

/** ZWSP spacer 文本（image-chip / slash-chip 后跟的零宽空格，移除占位 badge 时一并清） */
export const CHIP_SPACER_ZWSP = '\u200B'

// ── 来自 useContenteditableInput：segments / 文本提取 ──

/**
 * 把 contenteditable DOM 解析为 Segment[]（W2）。
 *
 * TreeWalker 遍历逻辑与原 getTextFromEl 一致（SHOW_TEXT | SHOW_ELEMENT，跳过 .chip-x），
 * 但产出结构化 segment 而非拍平字符串：
 * - .slash-chip 元素 → 读 dataset.chipType：'skill' 产出 skill segment（有 location 则带上），
 *   其余产出 text segment（读 .chip-label 的 textContent）。遇到 chip 元素后跳过其子树
 *   （icon/label/x 按钮不单独遍历）——用 rejectChipSubtree 集合在 acceptNode 里直接拒绝。
 * - 文本节点：累加进当前 text segment（相邻文本节点合并，不每个产一个 segment），
 *   过滤 \u00A0→空格、\u200B→删除（与原 getTextFromEl 一致）。
 * - BR：在当前 text segment 里追加 \n。
 */
export function getSegmentsFromEl(el: HTMLDivElement | null): Segment[] {
  if (!el) return []
  const segments: Segment[] = []
  let pendingText: string | null = null
  const rejectChips = new Set<Element>()

  const flushText = (): void => {
    if (pendingText !== null && pendingText !== '') {
      segments.push({ type: 'text', text: pendingText })
    }
    pendingText = null
  }

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node): number {
      if (node.parentElement?.closest('.chip-x') || (node as Element).closest?.('.chip-x')) {
        return NodeFilter.FILTER_REJECT
      }
      for (const chip of rejectChips) {
        if (chip.contains(node)) return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  while (walker.nextNode()) {
    const node = walker.currentNode

    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).classList?.contains('slash-chip')) {
      const chip = node as HTMLElement
      const chipType = chip.dataset.chipType
      if (chipType === 'skill') {
        flushText()
        const name = chip.dataset.chipName ?? ''
        const location = chip.dataset.chipLocation
        segments.push(location ? { type: 'skill', name, location } : { type: 'skill', name })
      } else {
        const labelText = chip.querySelector('.chip-label')?.textContent ?? ''
        pendingText = (pendingText ?? '') + labelText
      }
      rejectChips.add(chip)
      continue
    }

    if (
      node.nodeType === Node.ELEMENT_NODE &&
      ((node as Element).classList?.contains('image-chip') ||
        (node as HTMLElement).dataset?.chipType === 'image')
    ) {
      const chip = node as HTMLElement
      const chipPath = chip.dataset.chipPath ?? ''
      // 占位符（粘贴/拖入 pending）path 无效，留在 DOM 但不进 segments（发送时静默丢弃）
      if (/^__(?:paste|drag)_pending_[0-9a-f-]+__$/.test(chipPath)) {
        rejectChips.add(chip)
        continue
      }
      flushText()
      segments.push({
        type: 'image',
        id: chip.dataset.chipId ?? '',
        path: chip.dataset.chipPath ?? '',
        fileName: chip.dataset.chipFileName ?? '',
        displayName: chip.dataset.chipDisplayName ?? '',
        needsMigrate: chip.dataset.chipNeedsMigrate === 'true',
      })
      rejectChips.add(chip)
      continue
    }

    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).classList?.contains('mention-file')) {
      const chip = node as HTMLElement
      flushText()
      const path = chip.dataset.chipPath ?? ''
      const ls = chip.dataset.chipLineStart
      const le = chip.dataset.chipLineEnd
      if (ls !== undefined && le !== undefined) {
        segments.push({ type: 'file', path, lineRange: [Number(ls), Number(le)] })
      } else {
        segments.push({ type: 'file', path })
      }
      rejectChips.add(chip)
      continue
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? ''
      const filtered = raw.replace(/\u00A0/g, ' ').replace(/\u200B/g, '')
      pendingText = (pendingText ?? '') + filtered
    } else if (node.nodeName === 'BR') {
      pendingText = (pendingText ?? '') + '\n'
    }
  }

  flushText()
  return segments
}

/** 提取纯文本：getSegmentsFromEl + segmentsToText 的便捷封装 */
export function getTextFromEl(el: HTMLDivElement | null): string {
  return segmentsToText(getSegmentsFromEl(el))
}

// ── 来自 useContenteditableInput：触发检测 ──

/** # 文件触发检测：基于光标位置，任意位置触发 */
export function detectHashTriggerFromEl(el: HTMLDivElement | null): { query: string } | null {
  if (!el) return null
  const sel = window.getSelection()
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null
  const node = sel.anchorNode
  if (!node || !el.contains(node)) return null
  const offset = sel.anchorOffset
  if (node.nodeType !== Node.TEXT_NODE) return null
  const beforeCursor = (node.textContent ?? '').slice(0, offset)
  const m = /(?:^|\s)#(\S*)$/.exec(beforeCursor)
  return m ? { query: m[1] } : null
}

// ── 来自 useContenteditableInput：光标 / 视觉行 ──

/**
 * 视觉行 rect 过滤器：`<br>` 硬换行会产生零宽 line box（left === right），
 * 这些零宽 rect 会污染 lineRects 导致 currentLine/targetLine 偏移（spec 缺陷 5）。
 *
 * 两种零宽 rect：行尾 br（top 与有宽行相同，过滤）vs 空行 br（top 独立，保留）。
 */
function getVisualLineRects(range: Range): DOMRect[] {
  const all = Array.from(range.getClientRects())
  const wide = all.filter((r) => r.right > r.left)
  const TOP_TOLERANCE = 1
  const blankLines = all.filter(
    (r) => r.right <= r.left && !wide.some((w) => Math.abs(w.top - r.top) <= TOP_TOLERANCE),
  )
  return [...wide, ...blankLines].sort((a, b) => a.top - b.top)
}

/** contenteditable insertLineBreak 后 0 rect 兜底探测（scrollCursorIntoView 用） */
export function getCaretLineRect(range: Range): DOMRect | null {
  const rect = range.getBoundingClientRect()
  if (rect.top !== 0 || rect.bottom !== 0 || rect.height !== 0) return rect
  const probe = document.createTextNode('\u200B')
  try {
    range.insertNode(probe)
    const probeRange = document.createRange()
    probeRange.selectNode(probe)
    const probeRect = probeRange.getBoundingClientRect()
    if (probeRect.top === 0 && probeRect.bottom === 0) return null
    return probeRect
  } finally {
    const parent = probe.parentNode
    probe.remove()
    if (parent?.nodeType === Node.ELEMENT_NODE) {
      ;(parent as Element).normalize()
    }
  }
}

/**
 * 视觉行上/下移动（模块级纯函数，preferred X 由调用方传入/写回）。
 *
 * ⚠️ 权威规则见 `.xyz-harness/2026-07-10-composer-history-navigation/spec.md` FR1 + FR5。
 * getClientRects + caretRangeFromPoint 坐标方案（sel.modify 对软换行 contenteditable 失效）。
 *
 * 注意：document.caretRangeFromPoint 在 jsdom 未实现，多行分支由 renderer 行为测试覆盖。
 */
export function moveCaretVerticalOf(
  el: HTMLElement,
  dir: 'up' | 'down',
  preferredX: number | null,
): VerticalMoveResult {
  const noop: VerticalMoveResult = { result: 'at-edge', preferredX }
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return noop
  const before = sel.getRangeAt(0)
  if (!el.contains(before.startContainer)) return noop

  const fullRange = document.createRange()
  fullRange.selectNodeContents(el)
  const lineRects = getVisualLineRects(fullRange)
  if (lineRects.length <= 1) return noop

  let caretRect = before.getBoundingClientRect()
  if (caretRect.top === 0 && caretRect.bottom === 0) {
    const probed = getCaretLineRect(before)
    if (probed) {
      caretRect = probed
    } else {
      const bc = before.startContainer, bo = before.startOffset
      sel.modify('move', dir, 'line')
      const after = sel.getRangeAt(0)
      return { result: (after.startContainer === bc && after.startOffset === bo) ? 'at-edge' : 'moved', preferredX }
    }
  }

  const activePreferredX = preferredX ?? caretRect.left

  let currentLine = -1
  for (let i = 0; i < lineRects.length; i++) {
    if (Math.abs(caretRect.top - lineRects[i].top) <= 1) { currentLine = i; break }
  }
  if (currentLine === -1) {
    let minDist = Infinity
    for (let i = 0; i < lineRects.length; i++) {
      const MIDPOINT_DIVISOR = 2
      const center = (lineRects[i].top + lineRects[i].bottom) / MIDPOINT_DIVISOR
      const dist = Math.abs(caretRect.top - center)
      if (dist < minDist) { minDist = dist; currentLine = i }
    }
  }
  if (currentLine === -1) return noop

  const targetLine = dir === 'up' ? currentLine - 1 : currentLine + 1
  if (targetLine >= lineRects.length) return noop
  if (targetLine < 0) {
    const firstText = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
    const isAtTextStart = firstText != null && before.startContainer === firstText && before.startOffset === 0
    if (isAtTextStart) return noop
    const range = document.createRange()
    range.setStart(firstText!, 0)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    return { result: 'moved', preferredX: activePreferredX }
  }

  const elRect = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const LINE_INTERIOR_OFFSET = 3
  let targetLineTop = lineRects[targetLine].top
  const NEEDS_SCROLL_MARGIN = 5
  if (targetLineTop < elRect.top + NEEDS_SCROLL_MARGIN || targetLineTop > elRect.bottom - NEEDS_SCROLL_MARGIN) {
    el.scrollTop += targetLineTop - elRect.top - parseFloat(cs.paddingTop) - NEEDS_SCROLL_MARGIN
    const freshRange = document.createRange()
    freshRange.selectNodeContents(el)
    const freshRects = getVisualLineRects(freshRange)
    if (targetLine < freshRects.length) targetLineTop = freshRects[targetLine].top
  }
  const targetY = targetLineTop + LINE_INTERIOR_OFFSET
  const BOUNDARY_QUIRK_OFFSET = 20
  const targetX = activePreferredX ?? (elRect.left + parseFloat(cs.paddingLeft) + BOUNDARY_QUIRK_OFFSET)

  const target = document.caretRangeFromPoint(targetX, targetY)
  if (!target || !el.contains(target.startContainer)) return noop

  if (target.startContainer === before.startContainer && target.startOffset === before.startOffset) {
    return noop
  }

  const targetRect = target.getBoundingClientRect()
  if (targetRect.top !== 0 || targetRect.bottom !== 0) {
    const onTargetLine = Math.abs(targetRect.top - lineRects[targetLine].top) <= 1
    const onCurrentLine = Math.abs(targetRect.top - lineRects[currentLine].top) <= 1
    if (!onTargetLine && onCurrentLine) return noop
  }

  sel.removeAllRanges()
  sel.addRange(target)
  return { result: 'moved', preferredX: activePreferredX }
}

// ── 来自 useContenteditableInput：粘贴 ──

/** Cmd/Ctrl+V 富呈现通路：从剪贴板取出第一个 image item，无则返回 null。 */
export function pickClipboardImageItem(e: ClipboardEvent): DataTransferItem | null {
  const items = e.clipboardData?.items
  if (!items) return null
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'file' && it.type.startsWith('image/')) return it
  }
  return null
}

// ── 来自 useComposerChipCommands：chip DOM 辅助 ──

/**
 * 在容器内按 chipPath 查找 image-chip 元素（dataset 遍历，路径含 CSS 特殊字符也安全）。
 *
 * [HISTORICAL] 曾用 el.querySelector(`.image-chip[data-chip-path="${path}"]`)，
 * 但 path 含 `"` / `]` 等 CSS 特殊字符时选择器解析失败。改为遍历比对 dataset.chipPath。
 */
export function findImageChipEl(el: HTMLElement, chipPath: string): HTMLElement | null {
  const chips = el.querySelectorAll<HTMLElement>('.image-chip')
  for (const chip of chips) {
    if (chip.dataset.chipPath === chipPath) return chip
  }
  return null
}

/**
 * 在容器内按 chipId 查找 image-chip 元素（C3：ContextChipsBar 删除回调用稳定唯一 id 定位）。
 */
export function findImageChipElById(el: HTMLElement, chipId: string): HTMLElement | null {
  const chips = el.querySelectorAll<HTMLElement>('.image-chip')
  for (const chip of chips) {
    if (chip.dataset.chipId === chipId) return chip
  }
  return null
}

/** 判断节点是否是纯空白 spacer（nbsp/零宽空格/空文本节点） */
export function isSpacerNode(node: Node | null): boolean {
  if (!node || node.nodeType !== Node.TEXT_NODE) return false
  const t = node.textContent ?? ''
  return t === '\u00A0' || t === '\u200B' || t === ''
}

/** 把光标定位到指定节点之后 */
export function placeCursorAfter(node: Node): void {
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/**
 * 移除 chip + 相邻的 spacer（nbsp/零宽空格/空文本节点）。
 *
 * [W2 重构] 原为 useComposerChipCommands 闭包内函数（直接调 onChanged）。
 * 迁入 input-dom 改为接收 onChanged 参数的纯函数，chip-commands 调用时传入。
 */
export function removeChipNode(chip: Node, onChanged: () => void): void {
  const next = chip.nextSibling as Node | null
  if (isSpacerNode(next)) {
    next?.parentNode?.removeChild(next)
  }
  chip.parentNode?.removeChild(chip)
  onChanged()
}
