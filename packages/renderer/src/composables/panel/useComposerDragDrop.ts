/**
 * useComposerDragDrop —— renderer 兼容 shim（W2 迁移过渡期）。
 *
 * 真实实现已迁入 @xyz-agent/core/domain/composer/input/dragdrop.ts。本文件为 re-export 兼容层：
 * 保持 Composer.vue 等旧调用方的 import 路径与签名零改动，内部组装 core 版所需的 pasteImage
 * 注入（handleImagePaste 走 writeSessionImage IPC，core 不能 import @/api）。
 *
 * W4 壳接入时删除本 shim，Composer.vue 改为直接 import core + 直接组装 deps。
 *
 * [W2 改造] 原 4 参数签名保持，shim 在末尾注入 { pasteImage: handleImagePaste } 调 core 版。
 */
import type { Ref } from 'vue'
import { useComposerDragDrop as useCoreDragDrop } from '@xyz-agent/core/domain/composer/input'
import type { ComposerInputInstance } from '@xyz-agent/core/domain/composer/input'
import { handleImagePaste } from './useImageAttachment'

export function useComposerDragDrop(
  inputRef: Ref<ComposerInputInstance | null>,
  composerBoxRef: Ref<HTMLElement | null>,
  onChanged: () => void,
  sessionId: Ref<string | null>,
) {
  return useCoreDragDrop(inputRef, composerBoxRef, onChanged, sessionId, { pasteImage: handleImagePaste })
}
