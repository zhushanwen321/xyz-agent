<template>
  <!--
    富文本输入区（draft-composer-states §1/§2e）。
    contenteditable div 取代 Textarea：支持 slash chip（§2e）与 @/# mention 内联 chip（§2d）。
    B 方案：富文本内联 token 必须 contenteditable，Textarea 物理上做不了。
    v-html 被项目规则禁用（vue/no-v-html），所有 DOM 操作走 ref 手动 API。
  -->
  <div
    ref="elRef"
    class="composer-input relative min-h-[60px] max-h-[120px] overflow-y-auto px-3.5 pb-1 pt-[11px] text-[13px] leading-[1.55] text-fg outline-none"
    :class="{ 'is-empty': isEmpty, 'is-focused': isFocused }"
    :contenteditable="!disabled"
    :data-placeholder="placeholder"
    role="textbox"
    aria-multiline="true"
    :aria-label="placeholder"
    spellcheck="false"
    @input="onInput"
    @keydown="onKeydown"
    @paste="onPaste"
    @focus="isFocused = true"
    @blur="onBlur"
    @compositionstart="composing = true"
    @compositionend="onCompositionEnd"
    @mouseup="saveSelection"
  />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useComposerChipCommands } from '@/composables/useComposerChipCommands'

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
  /** slash 命令触发检测：{query} 表示 / 在最左且无 chip；null 表示应关闭触发浮层 */
  'slash-trigger': [payload: { query: string } | null]
  /** # 文件触发检测：{query} 表示光标前有「空格/行首 + # + 非空白」序列；null 表示应关闭触发浮层 */
  'file-trigger': [payload: { query: string } | null]
}>()

const elRef = ref<HTMLDivElement | null>(null)
const composing = ref(false)
const isEmpty = ref(true)
/** 聚焦态：控制 placeholder 显隐（仅未聚焦且空时显）与光标可见性（未聚焦不显光标） */
const isFocused = ref(false)
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
  emit('input', text)
  // slash 触发检测：必须用 DOM 查询判 chip——getText 的 TreeWalker 跳过的是 .chip-x（×按钮），
  // 不跳 chip 本体，故 chip 文本（如 '/commit'）会被读入 text。若靠 text 判 chip 会误触发。
  // startsWith('/') 已隐含「/ 在最左且左侧无内容」，无需额外判断。
  const hasChip = !!getEl()?.querySelector('.slash-chip, .mention-chip')
  emit('slash-trigger', !hasChip && text.startsWith('/') ? { query: text.slice(1) } : null)
  // # 文件触发检测：基于光标位置（任意位置触发，不靠整框文本）
  emit('file-trigger', detectHashTrigger())
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

/** blur：清聚焦态（隐藏光标 + 末尾不再闪），并保存选区供命令浮层后恢复光标 */
function onBlur(): void {
  isFocused.value = false
  saveSelection()
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
// chip DOM 操作提取到 useComposerChipCommands（满足 <script setup> 行数上限）
const { insertSlashChip, insertMentionChip, handleBackspaceOnChip } = useComposerChipCommands(
  elRef,
  { onChanged: onInput, restoreSelection },
)

/** 清空 /query 过滤文本并把光标移回开头（选中 slash 命令后，Composer 调它清掉过滤文本，
 *  再调 insertSlashChip 插 chip）。不 emit slash-trigger（调用方已在关闭浮层）。 */
function clearSlashQueryText(): void {
  const el = getEl()
  if (!el) return
  el.textContent = ''
  savedRange = null
  syncEmpty()
  emit('input', '')
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
  emit('input', getText())
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
  isFocused.value = true
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
  clearSlashQueryText,
  clearHashQueryText,
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
   style.css 已加 --text-tertiary: var(--subtle) 兜底别名；此处显式用 --subtle 对齐 SSOT。
   —— absolute 脱文档流：不占行内位，光标始终在内容区最左（开头）而非 placeholder 末尾。
   —— 仅未聚焦且空时显（is-empty && !is-focused）：聚焦即隐，光标停在开头闪烁。 */
.composer-input.is-empty:not(.is-focused)::before {
  content: attr(data-placeholder);
  position: absolute;
  inset: 0;
  padding: inherit;
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
.composer-input :deep(.slash-chip .chip-icon) {
  display: inline-flex;
  align-items: center;
  color: var(--reasoning);
}
.composer-input :deep(.slash-chip .chip-icon svg) {
  width: 12px;
  height: 12px;
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
