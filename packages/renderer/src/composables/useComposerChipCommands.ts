import { type Ref } from 'vue'
import { createVNode, render } from 'vue'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'

/**
 * Composer 富文本 chip 的 DOM 操作（slash 命令 chip / @·# mention chip）。
 * 从 ComposerInput 提取以满足 <script setup> 行数上限（CLAUDE.md）。
 *
 * 依赖注入：
 * - elRef：contenteditable 根元素 ref
 * - onChanged：chip 变更后同步父组件状态（isEmpty/draft/slash-trigger），即 ComposerInput.onInput
 * - restoreSelection：恢复光标到命令浮层夺焦前的位置（insertMentionChip 用）
 */
interface ChipCallbacks {
  onChanged: () => void
  restoreSelection: () => void
}

export function useComposerChipCommands(
  elRef: Ref<HTMLDivElement | null>,
  { onChanged, restoreSelection }: ChipCallbacks,
) {
  function getEl(): HTMLDivElement | null {
    return elRef.value
  }

  /** 判断节点是否是纯空白 spacer（nbsp/零宽空格/空文本节点） */
  function isSpacerNode(node: Node | null): boolean {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false
    const t = node.textContent ?? ''
    return t === '\u00A0' || t === '\u200B' || t === ''
  }

  /** 把光标定位到指定节点之后 */
  function placeCursorAfter(node: Node): void {
    const range = document.createRange()
    range.setStartAfter(node)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  /** 移除 chip + 相邻的 spacer（nbsp/零宽空格/空文本节点） */
  function removeChipNode(chip: Node): void {
    const next = chip.nextSibling as Node | null
    if (isSpacerNode(next)) {
      next?.parentNode?.removeChild(next)
    }
    chip.parentNode?.removeChild(chip)
    onChanged()
  }

  /** chip 的 × 删除按钮（slash chip 专用，§2e） */
  function makeXButton(chip: HTMLElement): HTMLElement {
    const x = document.createElement('span')
    x.className = 'chip-x'
    x.setAttribute('role', 'button')
    x.setAttribute('aria-label', '移除')
    x.textContent = '×'
    x.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      removeChipNode(chip)
    })
    return x
  }

  /**
   * 把 lucide 图标组件渲染进容器元素（contenteditable chip 走手动 DOM，无法用 <component>）。
   * render 到空容器再 appendChild：把生成的 <svg> 挂到 chip 文本前。
   * getText 的 TreeWalker(SHOW_TEXT) 不会读到 svg（无文本子节点），故图标不影响发送文本。
   */
  function renderIconInto(container: HTMLElement, iconKey?: string): void {
    const Comp = iconKey ? SLASH_ICON_COMPONENTS[iconKey as keyof typeof SLASH_ICON_COMPONENTS] : undefined
    if (!Comp) return
    const host = document.createElement('span')
    host.className = 'chip-icon'
    host.setAttribute('aria-hidden', 'true')
    render(createVNode(Comp, { size: 12 }), host)
    container.appendChild(host)
  }

  /** 插入 slash 命令 chip（§2e：必须在最前，只允许一个，整体可删，× 可点删）。
   *  icon 按 source 透传（extension→terminal / skill→star / 默认 wrench），与选择框图标一致。
   *
   *  命令名归一化：pi getCommands 返回的 name 不带 / 前缀（如 'goal'），但 slash 命令
   *  发送给 pi 时必须以 / 开头（pi 按前缀路由命令），且 chip label 显示也依赖 / 前缀
   *  （与用户手打 /goal 的 draft 一致）。此处统一补 / 前缀，兼容已带前缀的调用方
   *  （如无 session 时 skill fallback 已补 / 的 /skill:xxx）。 */
  function insertSlashChip(command: string, icon?: string): void {
    const el = getEl()
    if (!el) return
    el.focus()
    // 只允许一个 slash chip：移除已有的
    el.querySelectorAll('.slash-chip').forEach((n) => removeChipNode(n))
    const chip = document.createElement('span')
    chip.className = 'slash-chip'
    chip.contentEditable = 'false'
    renderIconInto(chip, icon)
    const label = document.createElement('span')
    label.className = 'chip-label'
    // 归一化：确保 / 前缀（pi getCommands 返回无前缀，发送和显示都依赖它）
    label.textContent = command.startsWith('/') ? command : `/${command}`
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    // chip 必须在输入流最前（slash 命令是操作模式前缀）
    el.insertBefore(chip, el.firstChild)
    // chip 后补零宽空格（不可见但可定位光标，输入文字正常追加，getText 过滤）
    const spacer = document.createTextNode('\u200B')
    chip.after(spacer)
    placeCursorAfter(spacer)
    onChanged()
  }

  /** 插入 @/# mention 内联 chip（§2d：蓝名/绿名，插在当前光标位置） */
  function insertMentionChip(type: '@' | '#', name: string): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = type === '@' ? 'mention-chip mention-at' : 'mention-chip mention-file'
    chip.contentEditable = 'false'
    chip.textContent = `${type}${name}`
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) {
      el.appendChild(chip)
    } else {
      const range = sel.getRangeAt(0)
      range.deleteContents()
      range.insertNode(chip)
    }
    const spacer = document.createTextNode('\u200B')
    chip.after(spacer)
    placeCursorAfter(spacer)
    onChanged()
  }

  /**
   * Backspace 紧跟 chip 时整体删 chip（§2e：backspace 一次删整块）。
   * 检测：光标前的节点是 chip（中间最多一个 spacer 文本节点）。
   * 返回 true 表示已处理（调用方 preventDefault）。
   */
  function handleBackspaceOnChip(): boolean {
    const el = getEl()
    if (!el) return false
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
    if (!el.contains(sel.anchorNode)) return false
    const range = sel.getRangeAt(0)
    const container = range.startContainer
    const offset = range.startOffset
    let prev: Node | null = null
    if (container.nodeType === Node.TEXT_NODE) {
      const text = container.textContent ?? ''
      if (offset === 0) {
        prev = container.previousSibling
      } else if (isSpacerNode(container) && offset === text.length) {
        // 光标在 spacer 末尾：跳过 spacer 看前一个节点
        prev = container.previousSibling
      } else {
        return false // 正常字符删除，交给浏览器
      }
    } else {
      prev = container.childNodes[offset - 1] ?? null
    }
    if (prev && prev.nodeType === Node.ELEMENT_NODE) {
      const ep = prev as HTMLElement
      if (ep.classList.contains('slash-chip') || ep.classList.contains('mention-chip')) {
        removeChipNode(ep)
        return true
      }
    }
    return false
  }

  return { insertSlashChip, insertMentionChip, handleBackspaceOnChip }
}
