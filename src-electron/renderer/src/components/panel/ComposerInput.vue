<template>
  <!--
    富文本输入区（draft-composer-states §1/§2e）。
    contenteditable div 取代 Textarea：支持 slash chip（§2e）与 @/# mention 内联 chip（§2d）。
    B 方案：富文本内联 token 必须 contenteditable，Textarea 物理上做不了。
    v-html 被项目规则禁用（vue/no-v-html），所有 DOM 操作走 ref 手动 API。
  -->
  <div
    ref="elRef"
    class="composer-input min-h-[40px] max-h-[120px] overflow-y-auto px-3.5 pb-1 pt-[11px] text-[13px] leading-[1.55] text-fg outline-none"
    :class="{ 'is-empty': isEmpty }"
    :contenteditable="!disabled"
    :data-placeholder="placeholder"
    role="textbox"
    aria-multiline="true"
    :aria-label="placeholder"
    spellcheck="false"
    @input="onInput"
    @keydown="onKeydown"
    @paste="onPaste"
    @compositionstart="composing = true"
    @compositionend="onCompositionEnd"
    @blur="saveSelection"
    @mouseup="saveSelection"
  />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

withDefaults(
  defineProps<{
    placeholder?: string
    disabled?: boolean
  }>(),
  { placeholder: '', disabled: false },
)

const emit = defineEmits<{
  input: [text: string]
  keydown: [e: KeyboardEvent]
}>()

const elRef = ref<HTMLDivElement | null>(null)
const composing = ref(false)
const isEmpty = ref(true)
/** 保存的光标 Range：命令浮层打开会夺走焦点，选中后需恢复光标再插 chip */
let savedRange: Range | null = null

function getEl(): HTMLDivElement | null {
  return elRef.value
}

function getText(): string {
  const el = getEl()
  if (!el) return ''
  // TreeWalker 遍历：跳过 chip 的 × 按钮文本，避免发送内容混入 '×'
  let text = ''
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text): number {
      return node.parentElement?.closest('.chip-x')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })
  while (walker.nextNode()) {
    text += (walker.currentNode as Text).textContent ?? ''
  }
  // nbsp 转普通空格；零宽空格（chip 后的可定位锚点）过滤掉
  return text.replace(/\u00A0/g, ' ').replace(/\u200B/g, '')
}

function syncEmpty(): void {
  isEmpty.value = getText().trim() === ''
}

function onInput(): void {
  syncEmpty()
  emit('input', getText())
}

function onCompositionEnd(): void {
  composing.value = false
  onInput()
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
      return
    }
    // Enter（无 shift）：交给 Composer 决定发送/steer/followup
    emit('keydown', e)
    return
  }
  // Backspace：光标紧跟 chip 时整体删 chip（§2e spec：backspace 一次删整块）
  if (e.key === 'Backspace' && handleBackspaceOnChip()) {
    e.preventDefault()
    return
  }
  emit('keydown', e)
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

// ============ 富文本 chip（§2e slash / §2d mention） ============

/** 判断节点是否是纯空白 spacer（nbsp/零宽空格/空文本节点） */
function isSpacerNode(node: Node | null): boolean {
  if (!node || node.nodeType !== Node.TEXT_NODE) return false
  const t = node.textContent ?? ''
  return t === '\u00A0' || t === '\u200B' || t === ''
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
  onInput()
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

/** 插入 slash 命令 chip（§2e：必须在最前，只允许一个，整体可删，× 可点删） */
function insertSlashChip(command: string): void {
  const el = getEl()
  if (!el) return
  el.focus()
  // 只允许一个 slash chip：移除已有的
  el.querySelectorAll('.slash-chip').forEach((n) => removeChipNode(n))
  const chip = document.createElement('span')
  chip.className = 'slash-chip'
  chip.contentEditable = 'false'
  chip.textContent = command
  chip.appendChild(makeXButton(chip))
  // chip 必须在输入流最前（slash 命令是操作模式前缀）
  el.insertBefore(chip, el.firstChild)
  // chip 后补零宽空格（不可见但可定位光标，输入文字正常追加，getText 过滤）
  const spacer = document.createTextNode('\u200B')
  chip.after(spacer)
  placeCursorAfter(spacer)
  onInput()
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
  onInput()
}

function clear(): void {
  const el = getEl()
  if (!el) return
  el.textContent = ''
  savedRange = null
  syncEmpty()
  emit('input', '')
}

/** 在当前光标处插入纯文本（+ 菜单插 @/#/ 符号用） */
function insertTextAtCursor(text: string): void {
  const el = getEl()
  if (!el) return
  restoreSelection()
  document.execCommand('insertText', false, text)
  onInput()
}

/** 写入纯文本并把光标移到末尾（发送失败恢复草稿用） */
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
  emit('input', text)
}

function focus(): void {
  getEl()?.focus()
}

defineExpose({
  clear,
  focus,
  getText,
  setText,
  insertTextAtCursor,
  insertSlashChip,
  insertMentionChip,
  saveSelection,
  restoreSelection,
})

onMounted(() => {
  syncEmpty()
})
</script>

<style scoped>
/* placeholder：伪元素 Tailwind 表达不了，走 scoped style。
   用 --subtle（三级文字/占位，design-tokens SSOT + design-system §4 明确）。
   设计意图：占位是三级最暗层，与输入正文 --fg 拉开梯度，弱化提示语。
   原 var(--text-tertiary) 未定义会回退到 inherit → --fg（与正文同亮，丧失占位语义），
   style.css 已加 --text-tertiary: var(--subtle) 兜底别名；此处显式用 --subtle 对齐 SSOT。 */
.composer-input.is-empty::before {
  content: attr(data-placeholder);
  color: var(--subtle);
  pointer-events: none;
}

/* slash 命令 chip（§2e：紫色整体 chip，backspace 整体删，× 点删） */
.composer-input :deep(.slash-chip) {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-right: 1px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: rgba(167, 139, 250, 0.18);
  color: var(--reasoning);
  font: 500 12px / 1.4 var(--font-sans);
  user-select: none;
}
.composer-input :deep(.slash-chip .chip-x) {
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  opacity: 0.5;
}
.composer-input :deep(.slash-chip .chip-x:hover) {
  opacity: 1;
  color: var(--danger);
}

/* @ 引用 / # 文件 mention 内联 chip（§2d：蓝名 / 绿名） */
.composer-input :deep(.mention-chip) {
  display: inline;
  padding: 1px 4px;
  border-radius: var(--radius-sm);
  font: 500 12px / 1.4 var(--font-sans);
  user-select: none;
}
.composer-input :deep(.mention-chip.mention-at) {
  color: var(--accent);
  background: rgba(79, 142, 247, 0.1);
}
.composer-input :deep(.mention-chip.mention-file) {
  color: var(--success);
  background: rgba(52, 211, 153, 0.1);
}
</style>
