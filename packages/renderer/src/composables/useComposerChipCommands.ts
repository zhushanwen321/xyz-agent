/**
 * useComposerChipCommands —— renderer 兼容 shim（W2 迁移过渡期）。
 *
 * 真实实现已迁入 @xyz-agent/core/domain/composer/input/chip-commands.ts。本文件为 re-export
 * 兼容层：保持 ComposerInput.vue 等旧调用方的 import 路径零改动，内部组装 core 版所需的
 * getSlashIcon/t 注入（替代 import SLASH_ICON_COMPONENTS / i18n，core 不能 import 这些壳层资源）。
 *
 * W4 壳接入时删除本 shim，ComposerInput.vue 改为直接 import core + 直接组装 deps。
 *
 * [W2 改造] 原 callbacks 不含 getSlashIcon/t（W2 新增），shim 自动注入。
 */
import type { Component, Ref } from 'vue'
import {
  useComposerChipCommands as useCoreChipCommands,
  findImageChipEl,
  findImageChipElById,
} from '@xyz-agent/core/domain/composer/input'
import type { ChipCallbacks } from '@xyz-agent/core/domain/composer/input'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import i18n from '@/i18n'

/** 旧 callbacks 类型（不含 W2 新增的 getSlashIcon/t，由 shim 注入） */
type LegacyChipCallbacks = Omit<ChipCallbacks, 'getSlashIcon' | 't'>

export function useComposerChipCommands(
  elRef: Ref<HTMLDivElement | null>,
  callbacks: LegacyChipCallbacks,
) {
  return useCoreChipCommands(elRef, {
    ...callbacks,
    getSlashIcon: (iconKey: string): Component | undefined =>
      SLASH_ICON_COMPONENTS[iconKey as keyof typeof SLASH_ICON_COMPONENTS],
    t: (key: string): string => i18n.global.t(key),
  })
}

export { findImageChipEl, findImageChipElById }
