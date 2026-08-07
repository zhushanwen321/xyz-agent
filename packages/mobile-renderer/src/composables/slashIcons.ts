/**
 * slash 命令 icon 组件映射（SSOT）。
 * CommandPopover（选择框图标）与 useComposerChipCommands（内联 chip 图标）共用，
 * 保证两处 source → icon 推断一致（extension→terminal / skill→star / 默认 wrench）。
 *
 * markRaw：组件对象无需响应式代理，跳过 reactivity 避免无谓开销（reka-ui / lucide 惯例）。
 */
import { markRaw } from 'vue'
import { Braces, FileText, Folder, Star, Terminal, Wrench } from '@lucide/vue'

/** source → icon key（与 CommandPopover.iconForSource 同源，集中维护避免漂移） */
export function iconKeyForSource(source: string): string {
  if (source === 'extension') return 'terminal'
  if (source === 'skill') return 'star'
  return 'wrench'
}

/** icon key → lucide 组件（slash chip 与选择框共用同一映射） */
export const SLASH_ICON_COMPONENTS = {
  file: markRaw(FileText),
  symbol: markRaw(Braces),
  skill: markRaw(Star),
  folder: markRaw(Folder),
  terminal: markRaw(Terminal),
  wrench: markRaw(Wrench),
  star: markRaw(Star),
}
