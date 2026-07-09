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
import { useContenteditableInput } from '@/composables/panel/useContenteditableInput'

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
/** 聚焦态：控制 placeholder 显隐（仅未聚焦且空时显）与光标可见性（未聚焦不显光标） */
const isFocused = ref(false)

// contenteditable 输入机制（getText/syncEmpty/触发检测/光标滚动/选区保存恢复/IME 守卫/换行/粘贴）
// 提取到 useContenteditableInput（满足 <script setup> 行数上限）。
// 两个 composable 互依：本 composable 的 onKeydown 要调 chip composable 的 handleBackspaceOnChip，
// chip composable 的 onChanged/restoreSelection 要用本 composable 的 onInput/restoreSelection。
// 解耦：handleBackspaceOnChip 仅在运行期（onKeydown 触发）被调，setup 期可暂留占位再后赋值，
// 故先声明本 composable，把 handleBackspaceOnChip 经 forwardRef 后赋，再声明 chip composable。
let handleBackspaceOnChip: () => boolean = () => false
const {
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
  moveCaretUpVisualLine,
  isCaretOnFirstLine,
  moveCaretToFirstLineEnd,
} = useContenteditableInput(elRef, {
  onInput: (text) => emit('input', text),
  onSlashTrigger: (payload) => emit('slash-trigger', payload),
  onFileTrigger: (payload) => emit('file-trigger', payload),
  onEnterKeydown: (e) => emit('keydown', e),
  onKeydown: (e) => emit('keydown', e),
  handleBackspaceOnChip: () => handleBackspaceOnChip(),
})

// ============ 富文本 chip（§2e slash / §2d mention） ============
// chip DOM 操作提取到 useComposerChipCommands（满足 <script setup> 行数上限）。
const chipCommands = useComposerChipCommands(elRef, {
  onChanged: onInput,
  restoreSelection,
})
const insertSlashChip = chipCommands.insertSlashChip
const insertMentionChip = chipCommands.insertMentionChip
// 后赋值：补回上面 forward 占位（setup 同步执行完毕，onKeydown 运行期读到真实实现）
handleBackspaceOnChip = chipCommands.handleBackspaceOnChip

/** blur：清聚焦态（隐藏光标 + 末尾不再闪），并保存选区供命令浮层后恢复光标 */
function onBlur(): void {
  isFocused.value = false
  saveSelection()
}

// clear / setText / insertTextAtCursor 不再在组件定义：DOM 写入已收口进 composable
// （savedRange 闭包在 composable 内，组件层无法重置它；详见 useContenteditableInput 注释）。
// 组件通过 defineExpose 透传 composable 返回的同名方法，维持对外 API 契约不变。

function focus(): void {
  isFocused.value = true
  elRef.value?.focus()
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
  moveCaretUpVisualLine,
  isCaretOnFirstLine,
  moveCaretToFirstLineEnd,
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
  /* 与后续文字空开约一字符宽（4px），避免 chip 边框贴紧正文 */
  margin-right: 4px;
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
  /* 与后续文字空开约一字符宽（4px），与 slash-chip 对齐 */
  margin-right: 4px;
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
