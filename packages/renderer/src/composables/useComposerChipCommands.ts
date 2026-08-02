import { type Ref } from 'vue'
import { createVNode, render } from 'vue'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import i18n from '@/i18n'

const t = i18n.global.t

/**
 * 在容器内按 chipPath 查找 image-chip 元素（dataset 遍历，路径含 CSS 特殊字符也安全）。
 *
 * [HISTORICAL] 曾用 el.querySelector(`.image-chip[data-chip-path="${path}"]`)，
 * 但 path 含 `"` / `]` 等 CSS 特殊字符时选择器解析失败（删除失效 / 重复 badge）。
 * 改为遍历所有 .image-chip 比对 dataset.chipPath，规避选择器转义。
 *
 * 用于异步回填场景（onPaste/onDrop 占位 badge 用唯一 placeholderMark 作 chipPath 定位回填）。
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
 * chipId 是 crypto.randomUUID()（无 CSS 特殊字符），但仍用 dataset 遍历与 findImageChipEl 保持一致。
 */
export function findImageChipElById(el: HTMLElement, chipId: string): HTMLElement | null {
  const chips = el.querySelectorAll<HTMLElement>('.image-chip')
  for (const chip of chips) {
    if (chip.dataset.chipId === chipId) return chip
  }
  return null
}

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
    x.setAttribute('aria-label', t('composable.removeLabel'))
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
    // 标注 chip data 属性，供 getSegmentsFromEl 重建 skill/slash segment（W2）。
    // skill 命令形如 /skill:cw-cli → chipType=skill, chipName=cw-cli；
    // 普通 slash 命令（如 /commit）→ chipType=slash, chipName=commit（不带 / 前缀）。
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
    // 显示层：skill 只显 chipName（icon+紫色已传达 skill 类型，/skill: 前缀对用户冗余）；
    // 普通 slash 命令保留 / 前缀（命令调用语义，与用户手打 /command 一致）。
    // 数据层不受影响：发送的 segment 由 getSegmentsFromEl 读 dataset.chipName 重建，不读 label。
    label.textContent = chip.dataset.chipType === 'skill'
      ? (chip.dataset.chipName ?? '')
      : (command.startsWith('/') ? command : `/${command}`)
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

  /**
   * 插入 # 文件引用内联 chip（结构化 file segment，ADR-0040）。
   *
   * 与旧 insertMentionChip('#', name) 的区别：设 dataset（chipType=file/chipPath/
   * chipLineStart/chipLineEnd）供 getSegmentsFromEl 重建 {type:file} segment，
   * 用 .chip-label 子元素显示路径（格式 D2：无范围 path；单行 path:L<n>；多行 path:L<s>-L<e>）。
   * 旧 # chip 无 dataset 被 getSegmentsFromEl 读成纯文本（结构丢失），本方法修复。
   * 复用 .mention-file 绿色样式（不新增 CSS 类），加 .chip-x 删除按钮（与 slash chip 一致）。
   *
   * 行范围格式（D2）：start===end 单行显示 L<start>；start!==end 多行显示 L<start>-L<end>。
   */
  function insertFileChip(path: string, lineRange?: [number, number]): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-file'
    chip.contentEditable = 'false'
    // 结构化 dataset：getSegmentsFromEl 依此重建 {type:file} segment
    chip.dataset.chipType = 'file'
    chip.dataset.chipPath = path
    let labelText = path
    if (lineRange) {
      const [start, end] = lineRange
      chip.dataset.chipLineStart = String(start)
      chip.dataset.chipLineEnd = String(end)
      // D2 格式：单行 L<n>，多行 L<s>-L<e>
      labelText += start === end ? `:L${start}` : `:L${start}-L${end}`
    }
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = labelText
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    // 插入光标处（同 mention chip，非最前）
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
   * 插入图片 badge（Cmd/Ctrl+V 富呈现通路：截图粘贴后在光标处插 image chip）。
   *
   * 与 insertFileChip 的区别：
   * - 样式带 .image-chip 修饰（紫色 reasoning 色，与 ContextChipsBar image 一致），复用 .mention-chip 基础样式（TO2）。
   * - dataset.chipType='image'（getSegmentsFromEl 依此重建 {type:image} segment，区别于 file 的 'file'）。
   * - dataset.chipId = uuid（C3：唯一标识，同一文件附两次时 ContextChipsBar :key 用它避免重复 path 冲突）。
   * - 无行范围概念，label 显 displayName（用户可读名）。
   *
   * fileName vs displayName（与 shared Segment image 段对齐）：
   * - fileName：磁盘文件全名（含 uuid 前缀，如 `dbfdb3c8-...-image.png`），用于磁盘定位/日志，
   *   写入 dataset.chipFileName 供 getSegmentsFromEl 重建 segment.fileName。
   * - displayName：用户可读名（如 `截图-20260725-1530.png`），用于 badge label 显示，
   *   写入 dataset.chipDisplayName 供 getSegmentsFromEl 重建 segment.displayName。
   *
   * needsMigrate：是否需要 tmpdir → attachments 迁移（landing 态 writeSessionImage 落 tmpdir 的图 true）。
   * 写入 dataset.chipNeedsMigrate 供 getSegmentsFromEl 重建 segment.needsMigrate。+菜单选的用户磁盘文件
   * needsMigrate 必须为 false（否则会被 renameSync 移走——数据丢失）。默认 false（省略参数等价 false）。
   */
  function insertImageBadge(path: string, fileName: string, displayName: string, needsMigrate: boolean = false): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-file image-chip'
    chip.contentEditable = 'false'
    // 结构化 dataset：getSegmentsFromEl 依此重建 {type:image} segment
    chip.dataset.chipType = 'image'
    chip.dataset.chipId = crypto.randomUUID()
    chip.dataset.chipPath = path
    chip.dataset.chipFileName = fileName
    chip.dataset.chipDisplayName = displayName
    // needsMigrate 标志（M1：迁移判断用此字段而非猜路径，避免用户磁盘文件被误迁移）
    chip.dataset.chipNeedsMigrate = needsMigrate ? 'true' : 'false'
    const label = document.createElement('span')
    label.className = 'chip-label'
    // 显示层用 displayName（用户可读），磁盘全名 fileName 对用户冗余且含 uuid 前缀不美观
    label.textContent = displayName
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    // 插入光标处（同 file chip，非最前）
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
   * 插入 @ mention 内联 chip（§2d：蓝名，插在当前光标位置）。
   *
   * # file 引用已迁移到 insertFileChip（结构化，ADR-0040）。本方法只保留 @ 分支——
   * @mention 暂无结构化需求（无 Segment 消费方），保持纯文本 chip。
   * # 入口委托 insertFileChip（向后兼容现有 insertMentionChip('#', name) 调用方）。
   */
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
      if (ep.classList.contains('slash-chip') || ep.classList.contains('mention-chip') || ep.classList.contains('image-chip')) {
        removeChipNode(ep)
        return true
      }
    }
    return false
  }

  return { insertSlashChip, insertMentionChip, insertFileChip, insertImageBadge, handleBackspaceOnChip }
}
