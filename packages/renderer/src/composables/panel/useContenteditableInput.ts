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
  setText: (text: string) => void
  insertTextAtCursor: (text: string) => void
  /** 光标是否在第一行（composer history ↑ 触发判定：多行编辑时 ↑ 应是正常光标移动） */
  isCaretOnFirstLine: () => boolean
  /** 光标是否在最后一行（composer history ↓ 触发判定，与 ↑ 对称） */
  isCaretOnLastLine: () => boolean
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
  /** 首末行判定的亚像素容差（px）：浮点 rect 比较避免渲染舍入误判 */
  const CARET_LINE_TOLERANCE_PX = 2

  function getEl(): HTMLDivElement | null {
    return elRef.value
  }

  function getText(): string {
    const el = getEl()
    if (!el) return ''
    // TreeWalker 遍历 TEXT + ELEMENT：
    // - TEXT：收集文本（跳过 chip × 按钮文本，避免发送内容混入 '×'）
    // - ELEMENT：<br> 补 \n（Shift+Enter 产生的换行元素，SHOW_TEXT 会跳过它，
    //   导致发送文本丢失软换行，用户气泡无法保留换行）
    let text = ''
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node: Node): number {
        // chip × 按钮内的一切（含其子 <span>× 文本与自身）跳过
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
    // nbsp 转普通空格；零宽空格（chip 后的可定位锚点）过滤掉
    return text.replace(/\u00A0/g, ' ').replace(/\u200B/g, '')
  }

  function syncEmpty(): void {
    isEmpty.value = getText().trim() === ''
  }

  /**
   * # 文件触发检测（§2d：任意位置触发）。
   *
   * 与 slash 不同（slash 靠 text.startsWith('/') 判最左），# 是「任意位置」触发：
   * 必须基于光标位置判断——取光标前到所属文本节点开头的文本，正则匹配「空格/行首 + # + 非空白序列到光标」。
   *
   * 触发条件（用户确认）：
   * - # 前是空格或行首，# 后紧跟非空白 → 触发（query=# 后到光标的内容，可为空串）
   * - # 后遇空格（query 末尾是空格）→ 不匹配（终止浮层）
   *
   * @returns 触发时 { query }；否则 null（关闭浮层）
   */
  function detectHashTrigger(): { query: string } | null {
    const el = getEl()
    if (!el) return null
    const sel = window.getSelection()
    // 非折叠选区（用户选中一段文本）不触发；光标不在输入区内不触发
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null
    const node = sel.anchorNode
    if (!node || !el.contains(node)) return null
    const offset = sel.anchorOffset
    // 光标必须在文本节点内（chip 是 contentEditable=false 的元素节点，光标在其后由 spacer 文本节点承接）
    if (node.nodeType !== Node.TEXT_NODE) return null
    const beforeCursor = (node.textContent ?? '').slice(0, offset)
    // (?:^|\s)：# 前是行首或空白；# 后 (\S*) 到光标必须全非空白（遇空格则不匹配 → 终止）
    const m = /(?:^|\s)#(\S*)$/.exec(beforeCursor)
    return m ? { query: m[1] } : null
  }

  function onInput(): void {
    syncEmpty()
    const text = getText()
    emitInput(text)
    // slash 触发检测：必须用 DOM 查询判 chip——getText 的 TreeWalker 跳过的是 .chip-x（×按钮），
    // 不跳 chip 本体，故 chip 文本（如 '/commit'）会被读入 text。若靠 text 判 chip 会误触发。
    // startsWith('/') 已隐含「/ 在最左且左侧无内容」，无需额外判断。
    const hasChip = !!getEl()?.querySelector('.slash-chip, .mention-chip')
    onSlashTrigger(!hasChip && text.startsWith('/') ? { query: text.slice(1) } : null)
    // # 文件触发检测：基于光标位置（任意位置触发，不靠整框文本）
    onFileTrigger(detectHashTrigger())
  }

  function onCompositionEnd(): void {
    composing.value = false
    onInput()
  }

  /**
   * 光标是否在第一行。
   *
   * 判定：折叠选区的视觉 top（getBoundingClientRect().top）约等于容器内容区 top
   * （elRect.top + paddingTop）。contenteditable 无 textarea 的 selectionStart 行号，
   * 靠 Range 视觉矩形与容器 rect 比较是唯一可靠方式。
   *
   * 容差 2px：浮点 rect 比较避免亚像素抖动误判（首行 caret top 理论 == 内容区 top，
   * 实际可能有 1px 内的渲染舍入）。
   *
   * 无选区 / 非折叠选区 / 光标不在容器内 → 返回 false（保守，不触发 history）。
   */
  function isCaretOnFirstLine(): boolean {
    const el = getEl()
    if (!el) return false
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return false
    const caretRect = range.getBoundingClientRect()
    // 空内容时 caretRect 可能全 0，视作首行
    if (caretRect.top === 0 && caretRect.height === 0) return true
    const cs = getComputedStyle(el)
    const paddingTop = parseFloat(cs.paddingTop) || 0
    const elTop = el.getBoundingClientRect().top + paddingTop
    return Math.abs(caretRect.top - elTop) < CARET_LINE_TOLERANCE_PX
  }

  /**
   * 光标是否在最后一行。判定逻辑与 isCaretOnFirstLine 对称：比较 caret bottom 与
   * 容器内容区 bottom（elRect.bottom - paddingBottom）。
   */
  function isCaretOnLastLine(): boolean {
    const el = getEl()
    if (!el) return false
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return false
    const caretRect = range.getBoundingClientRect()
    if (caretRect.top === 0 && caretRect.height === 0) return true
    const cs = getComputedStyle(el)
    const paddingBottom = parseFloat(cs.paddingBottom) || 0
    const elBottom = el.getBoundingClientRect().bottom - paddingBottom
    return Math.abs(caretRect.bottom - elBottom) < CARET_LINE_TOLERANCE_PX
  }

  /**
   * Shift+Enter 后把光标滚动进可见区。
   * contenteditable insertLineBreak 后浏览器不自动滚动（与 textarea 不同）：
   * 当 max-h-[120px] 触发 overflow 时，连续换行会把光标推出可视区，视觉上"停在当前行"。
   * 实现：用折叠选区的 getBoundingClientRect 与容器 rect 比较，超出下沿则补偿 scrollTop。
   * 用 getBoundingClientRect 而非 offsetTop：前者是视口坐标，与 scrollTop 调整方向一致。
   */
  function scrollCursorIntoView(): void {
    const el = getEl()
    if (!el) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return
    const range = sel.getRangeAt(0).cloneRange()
    // 取光标所在行的视觉矩形（光标是折叠选区，rect 高度即行高，top 即该行上沿）
    const caretRect = range.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    // caret 在容器下沿之下 → 向下滚动补偿（caretRect.bottom - elRect.bottom 即溢出像素）
    if (caretRect.bottom > elRect.bottom) {
      el.scrollTop += caretRect.bottom - elRect.bottom
    } else if (caretRect.top < elRect.top) {
      // caret 在容器上沿之上（理论上插 <br> 不会发生，向上翻历史时可能）→ 向上补偿
      el.scrollTop -= elRect.top - caretRect.top
    }
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

  /** 保存当前选区（focus 前调用） */
  function saveSelection(): void {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && elRef.value?.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange()
    }
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
  function setText(text: string): void {
    const el = getEl()
    if (!el) return
    el.textContent = text
    savedRange = null
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
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
    isCaretOnFirstLine,
    isCaretOnLastLine,
  }
}
