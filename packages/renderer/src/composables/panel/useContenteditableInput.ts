/**
 * Composer 富文本 contenteditable 输入机制（从 ComposerInput.vue 拆出，满足 <script setup> 行数上限）。
 *
 * 职责（单一变化轴「contenteditable 输入事件 + 文本/光标操作」）：
 * - getText：TreeWalker 文本提取（跳过 chip 的 × 按钮文本）。
 * - syncEmpty / detectHashTrigger：空态判定与 # 文件触发检测（基于光标位置）。
 * - scrollCursorIntoView：Shift+Enter 后把光标滚动进可见区（contenteditable 不自动滚动）。
 * - saveSelection / restoreSelection：命令浮层夺焦前后保存/恢复光标 Range。
 * - clearSlashQueryText / clearHashQueryText：命令浮层选中后清过滤文本（slash 清整框 / # 只删到光标）。
 * - clear / setText / insertTextAtCursor：程序化整框写入（清空/恢复草稿/光标处插文本）。
 *   这些直接改 DOM 的操作必须收口在此 composable 内：因为 savedRange 闭包在此，
 *   组件层无法触达，任何整框 textContent 写入后都要 savedRange = null 否则 restoreSelection
 *   会恢复一个指向已被清空/替换节点的 stale Range（回归 bug：addRange 静默失败或光标错位）。
 * - onInput / onKeydown / onCompositionEnd / onPaste：输入事件处理（IME 守卫、Shift+Enter 换行、Enter 委派发送、纯文本粘贴）。
 * - onCompositionStart（由模板 @compositionstart="composing = true" 直绑，此处仅暴露 composing ref）。
 *
 * 不含：chip 的 DOM 创建/删除（在 useComposerChipCommands）、模板结构、props/emits 声明。
 *
 * 行为约定（byte-for-byte 与原 ComposerInput.vue 一致，CRITICAL）：
 * - IME 组合中（composing.value / e.isComposing）不拦截 Enter，交给浏览器。
 * - Shift+Enter → insertLineBreak + onInput + scrollCursorIntoView，return（阻止发送）。
 * - Enter（无 shift）→ emit('keydown', e)，由 Composer 决定发送/steer/followup。
 * - caret 滚动比较：折叠选区 getBoundingClientRect vs 容器 rect，超下沿则补 scrollTop。
 */
import { ref, type Ref } from 'vue'

/** 输入区触发事件回调（ComposerInput 通过 emit 转发） */
interface ContenteditableCallbacks {
  /** 输入文本变更（draft 同步） */
  onInput: (text: string) => void
  /** slash 触发检测：{query} 表示 / 在最左且无 chip；null 表示应关闭浮层 */
  onSlashTrigger: (payload: { query: string } | null) => void
  /** # 文件触发检测：{query} 表示光标前有「空格/行首 + # + 非空白」序列；null 表示应关闭浮层 */
  onFileTrigger: (payload: { query: string } | null) => void
  /** Enter（无 shift）委派：交给 Composer 决定发送/steer/followup */
  onEnterKeydown: (e: KeyboardEvent) => void
  /** 非 Enter 的其他键（Backspace chip 删除以外的）向上转发 */
  onKeydown: (e: KeyboardEvent) => void
  /**
   * Backspace 紧跟 chip 时整体删 chip（§2e：backspace 一次删整块）。
   * 返回 true 表示已处理（调用方 preventDefault）。由 useComposerChipCommands 提供。
   */
  handleBackspaceOnChip: () => boolean
}

/**
 * 视觉行 rect 过滤器：`<br>` 硬换行会产生零宽 line box（left === right），
 * 这些零宽 rect 会污染 lineRects 导致 currentLine/targetLine 偏移（spec 缺陷 5）。
 * 过滤后只保留真实视觉行（right > left）。
 *
 * [HISTORICAL] 缺陷 5：`<br>` 零宽 line box 的 top 与相邻真实行相同，被当作独立
 * 视觉行计入 lineRects 后，光标在 br 相邻行按 ↓ 会定位到零宽 rect（Y 不变），
 * 返回 moved 但光标实际没跨行（CDP 实测确认）。过滤零宽 rect 是根因修复。
 */
function getVisualLineRects(range: Range): DOMRect[] {
  return Array.from(range.getClientRects()).filter((r) => r.right > r.left)
}

/**
 * 视觉行上/下移动结果。
 * - result: 'moved'（已跨行或行内归位，消费事件）/ 'at-edge'（已在边缘行，调用方翻历史）
 * - preferredX: 更新后的 preferred X（首次垂直移动时记录 caretRect.left，后续保持）
 */
interface VerticalMoveResult {
  result: 'moved' | 'at-edge'
  preferredX: number | null
}

/**
 * 视觉行上/下移动（模块级纯函数，preferred X 由调用方传入/写回）。
 *
 * ⚠️ 权威规则见 `.xyz-harness/2026-07-10-composer-history-navigation/spec.md` FR1 + FR5。
 *
 * [HISTORICAL] spec 缺陷 1：Selection.modify('move', dir, 'line') 在软换行 contenteditable
 * 中完全失效，已改用 getClientRects + caretRangeFromPoint 坐标方案。
 * [HISTORICAL] spec 缺陷 5：`<br>` 零宽 line box 污染 lineRects 导致 ↓ 不跨行，
 * 已用 getVisualLineRects 过滤零宽 rect 修复。
 *
 * 实现方案（getClientRects + caretRangeFromPoint）：
 * 1. getVisualLineRects 获取每视觉行权威 rect（过滤 `<br>` 零宽 line box）
 * 2. caretRect.top 匹配 lineRects 确定当前视觉行
 * 3. 目标行 index（current ± 1），越界 → 'at-edge'
 * 4. caretRangeFromPoint(preferredX, targetLine.top + 3px) 定位目标行内部
 *    - Y: lineRect.top + 3px（行内部，避开行顶边界 quirks）
 *    - X: preferredX（记住的水平位置），null 时兜底为文本区左边缘 + 20px
 * 5. 0-rect 陷阱回退 Selection.modify
 *
 * preferred X 由调用方管理（composable 闭包内 preferredCaretX），水平移动/输入/点击
 * 后调用方置 null（详见 spec FR5）。
 */
function moveCaretVerticalOf(
  el: HTMLElement,
  dir: 'up' | 'down',
  preferredX: number | null,
): VerticalMoveResult {
  const noop: VerticalMoveResult = { result: 'at-edge', preferredX }
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return noop
  const before = sel.getRangeAt(0)
  if (!el.contains(before.startContainer)) return noop

  // 1. Build visual line map via getClientRects — filter out zero-width
  //    <br> line boxes that would corrupt line indexing (defect 5).
  const fullRange = document.createRange()
  fullRange.selectNodeContents(el)
  const lineRects = getVisualLineRects(fullRange)
  if (lineRects.length <= 1) return noop  // single line, nowhere to move

  // 2. Find current caret's visual line by matching caretRect.top against line rects
  const caretRect = before.getBoundingClientRect()
  if (caretRect.top === 0 && caretRect.bottom === 0) {
    // 0-rect trap: fall back to Selection.modify
    const bc = before.startContainer, bo = before.startOffset
    sel.modify('move', dir, 'line')
    const after = sel.getRangeAt(0)
    return { result: (after.startContainer === bc && after.startOffset === bo) ? 'at-edge' : 'moved', preferredX }
  }

  // Record preferred X on first vertical move (null = no prior ↑/↓ since last reset)
  const activePreferredX = preferredX ?? caretRect.left

  // Find which visual line the caret is on.
  // Strategy: exact top match first (caret at line start), then closest center.
  // At line boundaries (e.g. line 0 bottom=664, line 1 top=666, caret=666)
  // both lines match any tolerance — top match resolves this correctly.
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
  if (currentLine === -1) return noop  // can't determine current line

  // 3. Calculate target line
  const targetLine = dir === 'up' ? currentLine - 1 : currentLine + 1
  if (targetLine >= lineRects.length) return noop  // ↓ beyond last line
  if (targetLine < 0) {
    // ↑ beyond first line: snap to text start if not already there,
    // otherwise signal at-edge for history flip.
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

  // 4. Scroll target line into view if needed.
  //    getClientRects returns viewport-relative rects; caretRangeFromPoint also
  //    uses viewport coords. When the target line is scrolled out of view
  //    (rect.top < elRect.top or rect.bottom > elRect.bottom), the caret
  //    lookup would fail. Scroll first, then re-read rects (scroll changes them).
  const elRect = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const LINE_INTERIOR_OFFSET = 3
  let targetLineTop = lineRects[targetLine].top
  const NEEDS_SCROLL_MARGIN = 5
  if (targetLineTop < elRect.top + NEEDS_SCROLL_MARGIN || targetLineTop > elRect.bottom - NEEDS_SCROLL_MARGIN) {
    el.scrollTop += targetLineTop - elRect.top - parseFloat(cs.paddingTop) - NEEDS_SCROLL_MARGIN
    // Re-read line rects after scroll (viewport positions changed)
    const freshRange = document.createRange()
    freshRange.selectNodeContents(el)
    const freshRects = getVisualLineRects(freshRange)
    if (targetLine < freshRects.length) targetLineTop = freshRects[targetLine].top
  }
  const targetY = targetLineTop + LINE_INTERIOR_OFFSET
  // X: preferred caret X if available (preserves horizontal position across lines),
  // fallback to text area left edge + offset to avoid left-edge quirks
  const BOUNDARY_QUIRK_OFFSET = 20
  const targetX = activePreferredX ?? (elRect.left + parseFloat(cs.paddingLeft) + BOUNDARY_QUIRK_OFFSET)

  const target = document.caretRangeFromPoint(targetX, targetY)
  if (!target || !el.contains(target.startContainer)) return noop

  // 5. Verify the target is a genuinely different position
  if (target.startContainer === before.startContainer && target.startOffset === before.startOffset) {
    return noop
  }

  // 5.5. Verify the target actually landed on the target line.
  //      caretRangeFromPoint at left-edge has quirks: it can return a position
  //      on the wrong line (e.g. targeting line 1 start but landing on line 0 end,
  //      or targeting line 0 end but landing at offset 2 instead of true line start).
  //      If the result is still on the current line, treat as 'at-edge' — the
  //      caret didn't actually cross a line boundary.
  const targetRect = target.getBoundingClientRect()
  if (targetRect.top !== 0 || targetRect.bottom !== 0) {
    const onTargetLine = Math.abs(targetRect.top - lineRects[targetLine].top) <= 1
    const onCurrentLine = Math.abs(targetRect.top - lineRects[currentLine].top) <= 1
    if (!onTargetLine && onCurrentLine) return noop
  }

  // 6. Commit the move
  sel.removeAllRanges()
  sel.addRange(target)
  return { result: 'moved', preferredX: activePreferredX }
}

/** 提取纯文本：TreeWalker 遍历 TEXT + ELEMENT，跳过 chip × 按钮文本 */
function getTextFromEl(el: HTMLDivElement | null): string {
  if (!el) return ''
  let text = ''
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node): number {
      if (node.parentElement?.closest('.chip-x') || (node as Element).closest?.('.chip-x')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
    } else if (node.nodeName === 'BR') {
      text += '\n'
    }
  }
  return text.replace(/\u00A0/g, ' ').replace(/\u200B/g, '')
}

/** # 文件触发检测：基于光标位置，任意位置触发 */
function detectHashTriggerFromEl(el: HTMLDivElement | null): { query: string } | null {
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

/** contenteditable insertLineBreak 后 0 rect 兜底探测 */
function getCaretLineRect(range: Range): DOMRect | null {
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
 * @param elRef contenteditable 根元素 ref
 * @param callbacks 触发事件 + Backspace-chip 删除委派
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
  saveSelection: () => void
  restoreSelection: () => void
  clearSlashQueryText: () => void
  clearHashQueryText: () => void
  clear: () => void
  /** 写入纯文本并把光标移到末尾（发送失败恢复草稿）。
   * CRITICAL：textContent= 替换整框内容，savedRange 指向的旧节点失效，必须置 null
   * （同 clear 理由），随后手动建立新光标 Range。
   */
  /** 写入纯文本并定位光标（'end'=末尾默认，'start'=首字符前，用于历史导航连续回溯） */
  setText: (text: string, caretPosition?: 'start' | 'end') => void
  /** 在当前光标处插入纯文本（菜单插 @/# 符号用） */
  insertTextAtCursor: (text: string) => void
  /**
   * 视觉行上/下移动。返回 'moved'（已跨行或行内归位，消费事件）/ 'at-edge'（已在边缘行行首/行末，调用方翻历史）。
   * 用 getClientRects + caretRangeFromPoint 实现跨视觉行移动，保持光标水平位置（preferred X）。
   * 自动处理 soft-wrap + `<br>` 混合场景。
   */
  moveCaretVertical: (dir: 'up' | 'down') => 'moved' | 'at-edge'
} {
  const {
    onInput: emitInput,
    onSlashTrigger,
    onFileTrigger,
    onEnterKeydown,
    onKeydown: forwardKeydown,
    handleBackspaceOnChip,
  } = callbacks

  /** IME 组合中（中文输入）：true 时 Enter 不拦截，交给浏览器 */
  const composing = ref(false)
  /** 空态：控制 placeholder 显隐（is-empty class） */
  const isEmpty = ref(true)
  /** 保存的光标 Range：命令浮层打开会夺走焦点，选中后需恢复光标再插 chip */
  let savedRange: Range | null = null
  /**
   * ↑/↓ 垂直移动时的 preferred X（视口坐标）。
   * 浏览器/VSCode 原生行为：连续按 ↑/↓ 保持光标水平位置；水平移动（←/→/Home/End）或
   * 输入/点击后重置为 null（下次 ↑/↓ 重新记录）。null 时用文本区左边缘作兜底。
   */
  let preferredCaretX: number | null = null

  function getEl(): HTMLDivElement | null {
    return elRef.value
  }

  function getText(): string {
    return getTextFromEl(getEl())
  }

  function syncEmpty(): void {
    isEmpty.value = getText().trim() === ''
  }

  /** # 文件触发检测（委托模块级 detectHashTriggerFromEl） */
  function detectHashTrigger(): { query: string } | null {
    return detectHashTriggerFromEl(getEl())
  }

  function onInput(): void {
    syncEmpty()
    const text = getText()
    // slash 命令后自动插入空格：/command:text → /command: text
    // [a-zA-Z0-9_-]+ 精确匹配命令字符（字母数字-_:），避免贪婪匹配吞掉后续文本
    const spaced = text.replace(/^(\/[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)(\S.*)$/, '$1 $2')
    if (spaced !== text) {
      // 自动插入空格后更新 DOM
      const el = getEl()
      if (el) el.textContent = spaced
      emitInput(spaced)
    } else {
      emitInput(text)
    }
    // 用户输入/删除改变了光标水平位置，重置 preferred X（下次 ↑/↓ 重新锚定）
    preferredCaretX = null
    // slash 触发检测：必须用 DOM 查询判 chip——getText 的 TreeWalker 跳过的是 .chip-x（×按钮），
    // 不跳 chip 本体，故 chip 文本（如 '/commit'）会被读入 text。若靠 text 判 chip 会误触发。
    // startsWith('/') 已隐含「/ 在最左且左侧无内容」，无需额外判断。
    const hasChip = !!getEl()?.querySelector('.slash-chip, .mention-chip')
    onSlashTrigger(!hasChip && spaced.startsWith('/') ? { query: spaced.slice(1) } : null)
    // # 文件触发检测：基于光标位置（任意位置触发，不靠整框文本）
    onFileTrigger(detectHashTrigger())
  }

  function onCompositionEnd(): void {
    composing.value = false
    onInput()
  }

  // getCaretLineRect 已提取为模块级函数（见文件顶部）

  function scrollCursorIntoView(): void {
    const el = getEl()
    if (!el) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return
    const range = sel.getRangeAt(0).cloneRange()
    const caretRect = getCaretLineRect(range)
    // 取不到有效 caret 矩形（空行 + ZWSP 探测也失败）→ 不修正 scrollTop，避免误操作
    if (!caretRect) return
    const elRect = el.getBoundingClientRect()
    // caret 在容器下沿之下 → 向下滚动补偿（caretRect.bottom - elRect.bottom 即溢出像素）
    if (caretRect.bottom > elRect.bottom) {
      el.scrollTop += caretRect.bottom - elRect.bottom
    } else if (caretRect.top < elRect.top) {
      // caret 在容器上沿之上（向上翻历史时可能）→ 向上补偿
      el.scrollTop -= elRect.top - caretRect.top
    }
  }

  /**
   * 视觉行上/下移动（薄封装：管理 preferredCaretX 实例状态，委托模块级 moveCaretVerticalOf）。
   * preferred X 重置由 onKeydown（水平键）/ onInput / saveSelection / setText / clear 触发。
   */
  function moveCaretVertical(dir: 'up' | 'down'): 'moved' | 'at-edge' {
    const el = getEl()
    if (!el) return 'at-edge'
    const { result, preferredX } = moveCaretVerticalOf(el, dir, preferredCaretX)
    preferredCaretX = preferredX
    return result
  }

  function onKeydown(e: KeyboardEvent): void {
    // IME 组合中（中文输入）不拦截，交给浏览器
    if (composing.value || e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        // Shift+Enter：手动插 <br>（统一换行元素，innerText 能正确解析）
        // ponytail: execCommand 已废弃但 insertLineBreak 在 contenteditable 仍是首选简化方案；
        // 升级路径：Selection API insertNode(textNode('\n')) + 手动光标定位
        document.execCommand('insertLineBreak')
        onInput()
        // contenteditable 与原生 textarea 不同：insertLineBreak 后浏览器不会自动滚动
        // 让光标进入可见区。手动比较光标 rect 与容器 rect，超界则调整 scrollTop。
        scrollCursorIntoView()
        return
      }
      // Enter（无 shift）：交给 Composer 决定发送/steer/followup
      onEnterKeydown(e)
      return
    }
    // Backspace：光标紧跟 chip 时整体删 chip（§2e spec：backspace 一次删整块）
    if (e.key === 'Backspace' && handleBackspaceOnChip()) {
      e.preventDefault()
      return
    }
    // 水平移动键重置 preferred X（与浏览器/VSCode 行为一致：←/→/Home/End 后 ↑/↓ 重新锚定水平位置）
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      preferredCaretX = null
    }
    forwardKeydown(e)
  }

  function onPaste(e: ClipboardEvent): void {
    // 只允许纯文本，剥离富文本/样式，保持 contenteditable 内容纯净
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') ?? ''
    // ponytail: execCommand 已废弃但 insertText 在 contenteditable 粘贴场景仍是首选简化方案
    document.execCommand('insertText', false, text)
    onInput()
  }

  /** 保存当前选区（focus 前调用）。鼠标点击也会触发（ComposerInput @mouseup），重置 preferred X */
  function saveSelection(): void {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && elRef.value?.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange()
    }
    preferredCaretX = null
  }

  /** 恢复选区（插 chip 前调用） */
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

  /** 清空 /query 过滤文本并把光标移回开头（选中 slash 命令后，Composer 调它清掉过滤文本，
   *  再调 insertSlashChip 插 chip）。不 emit slash-trigger（调用方已在关闭浮层）。 */
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
    range.collapse(true) // 光标到最前，为 insertSlashChip 让位（chip 必须插在最前）
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  /**
   * 清掉光标处的 #query 文本（选中文件后，Composer 调它清掉过滤文本，再调 insertMentionChip 插 chip）。
   *
   * 与 clearSlashQueryText 的关键差异：# 是任意位置触发，#query 可能在文本中间
   * （如 "code #auth|"），不能清整框——只删 # 到光标这段。
   *
   * 实现：基于当前 selection 定位光标文本节点内的 # 起点，构建 Range 删除 #query。
   * 降级：selection 失效（happy-dom / 光标已移）时直接 return，不阻断——chip 仍能插入，
   * 最多残留 #query 文本（后续可手动删）。
   */
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
    if (!m) return // 光标前无 # 触发序列，无需清理
    // m.index 是匹配起点（含 # 前的空格/行首边界字符）；# 实际位置在 m.index + 边界字符长度
    const boundaryLen = m[0].length - 1 - m[1].length // m[0]=边界+#+query，减去 # 和 query 长度
    const hashStart = (m.index ?? 0) + boundaryLen
    const range = document.createRange()
    range.setStart(node, hashStart)
    range.setEnd(node, offset)
    range.deleteContents()
    // 光标留在 # 原（已删）位置，供 insertMentionChip 的 restoreSelection + insertNode 接管
    sel.removeAllRanges()
    sel.addRange(range)
    syncEmpty()
    emitInput(getText())
  }

  /**
   * 程序化清空整框（发送成功后清输入区）。
   * CRITICAL：textContent='' 后 savedRange 指向的旧节点全部失效，必须置 null，
   * 否则下次 restoreSelection 会恢复 stale Range（光标错位/addRange 静默失败）。
   */
  function clear(): void {
    const el = getEl()
    if (!el) return
    el.textContent = ''
    savedRange = null
    preferredCaretX = null
    syncEmpty()
    emitInput('')
  }

  /** 在当前光标处插入纯文本（菜单插 @/# 符号用）。
   *  不重置 savedRange：execCommand('insertText') 基于当前 selection 插入，不清空整框，
   *  且本方法本身先 restoreSelection 用 savedRange 定位——这是设计意图，重置会破坏 chip 插入流程。 */
  function insertTextAtCursor(text: string): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    document.execCommand('insertText', false, text)
    onInput()
  }

  /**
   * 写入纯文本并把光标移到末尾（发送失败恢复草稿）。
   * CRITICAL：textContent= 替换整框内容，savedRange 指向的旧节点失效，必须置 null
   * （同 clear 理由），随后手动建立新光标 Range。
   */
  function setText(text: string, caretPosition: 'start' | 'end' = 'end'): void {
    const el = getEl()
    if (!el) return
    // 程序化写入重置 preferred X（历史回填/草稿恢复后光标在首/末，水平位置已无意义）
    preferredCaretX = null
    // \n → <br>：contenteditable 中 \n 是字面字符不渲染为换行，
    // 需用 <br> 元素分隔文本节点。纯文本 split/join，无 innerHTML/XSS 风险。
    el.replaceChildren()
    const parts = text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) el.appendChild(document.createElement('br'))
      if (parts[i]) el.appendChild(document.createTextNode(parts[i]))
    }
    savedRange = null
    el.focus()
    // 光标需定位到文本节点内部（而非元素节点边界），否则 Selection.modify 会先把光标
    // 「下沉」到文本节点并返回 moved，导致边缘判定多按一次键。用 TreeWalker 找首/末文本节点。
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
