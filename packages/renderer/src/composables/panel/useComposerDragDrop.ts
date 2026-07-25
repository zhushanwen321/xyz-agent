/**
 * Composer composer-box 拖拽落位处理（slice5 attach-dragdrop-menu）。
 *
 * 职责单一：把拖入 composer-box 的图片文件转成 image segment（复用 slice4 的
 * useImageAttachment.handleImagePaste 存文件链路），非图片文件忽略。
 *
 * 数据流：dragover → isDragOver=true（composer-box accent 边框反馈）；
 * drop → 遍历 dataTransfer.files，image/* 每项：插占位 badge「拖入中…」→
 * await handleImagePaste(file,{metaKey:true}) → 回填真实 path/name（badge）/降级文本；
 * dragleave → relatedTarget contains 检查防子元素冒泡误触发 → 真正离开 box 才复位 isDragOver。
 *
 * 复用 slice4 链路（handleImagePaste：file→base64→writeTmpImage IPC→image segment），
 * 占位回填范式等价 useContenteditableInput.handleImagePasteEvent（ClipboardEvent 私有函数，
 * DragEvent 不能复用故内联等价逻辑）。
 *
 * 不含：发送/steer/输入编辑（留 Composer.vue / 其他 composable）。
 */
import { ref, type Ref } from 'vue'
import { handleImagePaste } from './useImageAttachment'

/** ZWSP spacer 文本（image-chip 后跟的零宽空格，移除占位 badge 时一并清，同 useContenteditableInput） */
const CHIP_SPACER_ZWSP = '\u200B'

/** ComposerInput 实例最小契约（insertImageBadge 经 defineExpose 暴露） */
interface ComposerInputInstance {
  insertImageBadge: (path: string, name: string) => void
}

/**
 * @param inputRef ComposerInput 实例 ref（insertImageBadge 经 defineExpose 暴露）
 * @param composerBoxRef composer-box div 模板 ref（查占位 badge 用）
 * @param onChanged drop 处理后回调（刷新 ContextChipsBar chip 行）
 */
export function useComposerDragDrop(
  inputRef: Ref<ComposerInputInstance | null>,
  composerBoxRef: Ref<HTMLElement | null>,
  onChanged: () => void,
): {
  isDragOver: Ref<boolean>
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
} {
  /** composer-box 拖拽悬停态（accent 边框反馈数据源） */
  const isDragOver = ref(false)

  function onDragOver(_e: DragEvent): void {
    isDragOver.value = true
  }

  /** dragleave 防子元素冒泡误触发：relatedTarget 仍在 box 内则不复位；
   *  relatedTarget 为 null（拖出窗口）或 box 外才复位 isDragOver。 */
  function onDragLeave(e: DragEvent): void {
    const related = e.relatedTarget as Node | null
    if (related && composerBoxRef.value?.contains(related)) return
    isDragOver.value = false
  }

  /**
   * drop：遍历 dataTransfer.files，image/* 每项走占位 badge + handleImagePaste 回填范式；
   * 非图片文件忽略。末尾复位 isDragOver + 刷新 chip 行。
   *
   * 占位回填（等价 useContenteditableInput.handleImagePasteEvent）：
   * - 先 insertImageBadge(placeholderMark, '拖入中…') 占位
   * - await handleImagePaste(file, {metaKey:true})
   * - kind:'badge' → 回填占位 dataset.chipPath/chipName + label（占位不在则重插）
   * - kind:'text'  → 移除占位 + 相邻 ZWSP spacer，insertText 降级文本
   */
  function onDrop(e: DragEvent): void {
    isDragOver.value = false
    const files = Array.from(e.dataTransfer?.files ?? [])
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    e.preventDefault() // 已在模板 .prevent，双保险
    void (async () => {
      for (const file of imageFiles) {
        const placeholderMark = `__drag_pending_${crypto.randomUUID()}__`
        inputRef.value?.insertImageBadge(placeholderMark, '拖入中…')
        const result = await handleImagePaste(file, { metaKey: true })
        const placeholder = composerBoxRef.value?.querySelector<HTMLSpanElement>(
          `.image-chip[data-chip-path="${placeholderMark}"]`,
        )
        if (result.kind === 'badge') {
          if (placeholder) {
            placeholder.dataset.chipPath = result.path
            placeholder.dataset.chipName = result.name
            const label = placeholder.querySelector('.chip-label')
            if (label) label.textContent = result.name
          } else {
            inputRef.value?.insertImageBadge(result.path, result.name)
          }
        } else if (result.kind === 'text') {
          if (placeholder) {
            const next = placeholder.nextSibling
            if (next && next.nodeType === Node.TEXT_NODE && next.textContent === CHIP_SPACER_ZWSP) {
              next.remove()
            }
            placeholder.remove()
          }
          document.execCommand('insertText', false, result.text)
        }
        // kind==='noop' 不会出现（metaKey=true 必走 badge/text 分支）
      }
      onChanged()
    })()
  }

  return { isDragOver, onDragOver, onDragLeave, onDrop }
}
