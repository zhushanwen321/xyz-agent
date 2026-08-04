/**
 * slash 命令图标映射（w6 从 renderer composables/slashIcons.ts 迁入 ui）。
 *
 * UserBubble 的 skill chip 用 star 图标。markRaw 避免响应式包装组件。
 * 纯映射，无 renderer 依赖（仅 @lucide/vue）。
 */
import { markRaw } from 'vue'
import { FileText, Braces, Star, Folder, Terminal, Wrench } from '@lucide/vue'
import type { Component } from 'vue'

export const SLASH_ICON_COMPONENTS: Record<string, Component> = {
  file: markRaw(FileText),
  symbol: markRaw(Braces),
  skill: markRaw(Star),
  folder: markRaw(Folder),
  terminal: markRaw(Terminal),
  wrench: markRaw(Wrench),
  star: markRaw(Star),
}
