/**
 * useContenteditableInput —— renderer 兼容 shim（W2 迁移过渡期）。
 *
 * 真实实现已迁入 @xyz-agent/core/domain/composer/input/contenteditable.ts。本文件为 re-export
 * 兼容层：保持 ComposerInput.vue 等旧调用方的 import 路径与签名零改动，内部组装 core 版所需
 * 的 pasteImage 注入（handleImagePaste 走 writeSessionImage IPC，core 不能 import @/api）。
 *
 * W4 壳接入时删除本 shim，ComposerInput.vue 改为直接 import core + 直接组装 deps。
 *
 * [W2 改造] 原 callbacks 不含 pasteImage（W2 新增），shim 自动注入 handleImagePaste。
 */
import type { Ref } from 'vue'
import { useContenteditableInput as useCoreContenteditableInput } from '@xyz-agent/core/domain/composer/input'
import type { ContenteditableCallbacks } from '@xyz-agent/core/domain/composer/input'
import { handleImagePaste } from './useImageAttachment'

/** 旧 callbacks 类型（不含 W2 新增的 pasteImage，由 shim 注入） */
type LegacyContenteditableCallbacks = Omit<ContenteditableCallbacks, 'pasteImage'>

export function useContenteditableInput(
  elRef: Ref<HTMLDivElement | null>,
  callbacks: LegacyContenteditableCallbacks,
) {
  return useCoreContenteditableInput(elRef, { ...callbacks, pasteImage: handleImagePaste })
}

export { getSegmentsFromEl } from '@xyz-agent/core/domain/composer/input'
