/**
 * composer chip DOM 操作 —— core/domain/composer/input/chip-commands.ts（W2）。
 *
 * 定位：迁自 renderer useComposerChipCommands.ts（341 行）。slash 命令 chip / @·# mention chip /
 * image badge 的 DOM 创建与删除。
 *
 * [W2 改造] 原 import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons' + i18n，
 * 现经 callbacks.renderIcon/t 注入（ADR-0058 边界修复：createVNode/render 收敛为注入 callback，
 * dom-core 零 vue render import）。
 * DOM 辅助（findImageChipEl/isSpacerNode/placeCursorAfter/removeChipNode）委托 input-dom.ts。
 *
 * 不含：contenteditable 事件处理（contenteditable.ts）、模板结构、props/emits 声明。
 */
import { type Ref } from 'vue'
import { removeChipNode, isSpacerNode, placeCursorAfter } from './input-dom'
import type { ChipCallbacks } from './types'

export function useComposerChipCommands(
  elRef: Ref<HTMLDivElement | null>,
  { onChanged, restoreSelection, renderIcon, t }: ChipCallbacks,
) {
  function getEl(): HTMLDivElement | null {
    return elRef.value
  }

  /** chip 的 × 删除按钮（slash/file/image chip 通用，§2e） */
  function makeXButton(chip: HTMLElement): HTMLElement {
    const x = document.createElement('span')
    x.className = 'chip-x'
    x.setAttribute('role', 'button')
    x.setAttribute('aria-label', t('composable.removeLabel'))
    x.textContent = '×'
    x.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      removeChipNode(chip, onChanged)
    })
    return x
  }

  /**
   * chip 落位共用段：无选区 appendChild 到末尾，有选区删选区内容后插到光标处，
   * chip 后补 ZWSP spacer（光标锚点 + 删除 chip 时一并清理）并把光标定位其后。
   * file/image/mention/session/subagent 五种内联 chip 共用（结构惯例收敛，防五份漂移）。
   */
  function insertChipAtSelection(el: HTMLDivElement, chip: HTMLElement): void {
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
  }

  /**
   * 把 lucide 图标渲染进容器元素（contenteditable chip 走手动 DOM，无法用 <component>）。
   * 渲染经 callbacks.renderIcon 注入（壳层用 createVNode/render 实现），dom-core 只负责
   * DOM 编排：创建 host span → 调 renderIcon → 渲染成功才挂载。
   * getText 的 TreeWalker(SHOW_TEXT) 不会读到 svg（无文本子节点），故图标不影响发送文本。
   */
  function renderIconInto(container: HTMLElement, iconKey?: string): void {
    const host = document.createElement('span')
    host.className = 'chip-icon'
    host.setAttribute('aria-hidden', 'true')
    if (renderIcon(host, iconKey)) {
      container.appendChild(host)
    }
  }

  /** 插入 slash 命令 chip（§2e：必须在最前，只允许一个，整体可删，× 可点删）。 */
  function insertSlashChip(command: string, icon?: string): void {
    const el = getEl()
    if (!el) return
    el.focus()
    el.querySelectorAll('.slash-chip').forEach((n) => removeChipNode(n, onChanged))
    const chip = document.createElement('span')
    chip.className = 'slash-chip'
    chip.contentEditable = 'false'
    if (command.startsWith('/skill:')) {
      chip.dataset.chipType = 'skill'
      chip.dataset.chipName = command.slice('/skill:'.length)
    } else {
      chip.dataset.chipType = 'slash'
      chip.dataset.chipName = command.startsWith('/') ? command.slice(1) : command
    }
    renderIconInto(chip, icon)
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = chip.dataset.chipType === 'skill'
      ? (chip.dataset.chipName ?? '')
      : (command.startsWith('/') ? command : `/${command}`)
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    el.insertBefore(chip, el.firstChild)
    const spacer = document.createTextNode('\u200B')
    chip.after(spacer)
    placeCursorAfter(spacer)
    onChanged()
  }

  /** 插入 # 文件引用内联 chip（结构化 file segment，ADR-0040）。 */
  function insertFileChip(path: string, lineRange?: [number, number]): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-file'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'file'
    chip.dataset.chipPath = path
    let labelText = path
    if (lineRange) {
      const [start, end] = lineRange
      chip.dataset.chipLineStart = String(start)
      chip.dataset.chipLineEnd = String(end)
      labelText += start === end ? `:L${start}` : `:L${start}-L${end}`
    }
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = labelText
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /** 插入图片 badge（Cmd/Ctrl+V 富呈现通路）。 */
  function insertImageBadge(path: string, fileName: string, displayName: string, needsMigrate: boolean = false): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-file image-chip'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'image'
    chip.dataset.chipId = crypto.randomUUID()
    chip.dataset.chipPath = path
    chip.dataset.chipFileName = fileName
    chip.dataset.chipDisplayName = displayName
    chip.dataset.chipNeedsMigrate = needsMigrate ? 'true' : 'false'
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = displayName
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /** 插入 @ mention 内联 chip（§2d：蓝名）。# 入口委托 insertFileChip（向后兼容）。 */
  function insertMentionChip(type: '@' | '#', name: string): void {
    if (type === '#') {
      insertFileChip(name)
      return
    }
    const el = getEl()
    if (!el) return
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-at'
    chip.contentEditable = 'false'
    chip.textContent = `@${name}`
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /**
   * 插入 session 引用 chip（四符号体系 # session 新语义）。
   * 结构照 insertFileChip 惯例（chip-label + × 按钮 + dataset + ZWSP spacer）：
   * label 用于展示（人可读标题），sessionId 存 dataset 供 getSegmentsFromEl 产出
   * session segment（序列化为 #<sessionId>，对齐 TUI session_read 协议）。
   */
  function insertSessionChip(sessionId: string, label: string): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-session'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'session'
    chip.dataset.chipSessionId = sessionId
    chip.dataset.chipLabel = label
    const labelEl = document.createElement('span')
    labelEl.className = 'chip-label'
    labelEl.textContent = label
    chip.appendChild(labelEl)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /**
   * 插入 subagent 定向 chip（四符号体系 @ 新语义，修复 F3：现 mention-at 无 dataset）。
   * 复用 mention-at 蓝色样式（insertMentionChip 的视觉惯例），但结构升级：
   * dataset（chipType/chipSubagentId/chipSlug）+ chip-label + × 按钮——
   * 旧 insertMentionChip 产的无 dataset chip 保持不动（历史消息编辑兼容）。
   */
  function insertSubagentChip(subagentId: string, slug: string): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-at'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'subagent'
    chip.dataset.chipSubagentId = subagentId
    chip.dataset.chipSlug = slug
    const labelEl = document.createElement('span')
    labelEl.className = 'chip-label'
    labelEl.textContent = `@${slug}`
    chip.appendChild(labelEl)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /** Backspace 紧跟 chip 时整体删 chip（§2e：backspace 一次删整块）。返回 true 表示已处理。 */
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
        prev = container.previousSibling
      } else {
        return false
      }
    } else {
      prev = container.childNodes[offset - 1] ?? null
    }
    if (prev && prev.nodeType === Node.ELEMENT_NODE) {
      const ep = prev as HTMLElement
      if (ep.classList.contains('slash-chip') || ep.classList.contains('mention-chip') || ep.classList.contains('image-chip')) {
        removeChipNode(ep, onChanged)
        return true
      }
    }
    return false
  }

  return {
    insertSlashChip,
    insertMentionChip,
    insertFileChip,
    insertImageBadge,
    insertSessionChip,
    insertSubagentChip,
    handleBackspaceOnChip,
  }
}
