/**
 * slash 命令 icon 组件映射（SSOT）。
 * CommandPopover（选择框图标）与 useComposerChipCommands（内联 chip 图标）共用，
 * 保证两处命令 → icon 推断一致（builtin 命令各自独立 icon / 其他按 source 泛化）。
 *
 * 设计分层（避免 core 持有 view 资源）：
 * - core `command-store.ts` 产出 icon key 字符串（builtin 命令名 或 source 泛化 key），
 *   BUILTIN_COMMAND_ICON_KEYS 是命令名 SSOT
 * - 本文件（renderer）把 key 绑定到 lucide 组件，key 集合 = 泛化 key ∪ BUILTIN_COMMAND_ICON_KEYS
 *
 * markRaw：组件对象无需响应式代理，跳过 reactivity 避免无谓开销（reka-ui / lucide 惯例）。
 */
import { markRaw, type Component } from 'vue'
import {
  Braces,
  FileText,
  Folder,
  Star,
  Terminal,
  Wrench,
  // builtin 命令专属图标（对齐 demo v6 CommandPopover：每条命令独立 icon）
  Layers,
  Target,
  ListChecks,
  ShieldCheck,
  CalendarClock,
  Tag,
  Bot,
  Workflow,
  NotebookPen,
  SlidersHorizontal,
  Gauge,
  Grid3x3,
  PanelTop,
  Wand2,
} from '@lucide/vue'

/** re-export：让消费方（CommandPopover / chip 注入侧）从单一入口取 icon key 推断函数 */
export { iconKeyForCommand, bareCommandName } from '@xyz-agent/core'

/** 泛化 icon key → lucide 组件（fallback，与 source 映射对应） */
const GENERIC_ICON_COMPONENTS: Record<string, Component> = {
  file: markRaw(FileText),
  symbol: markRaw(Braces),
  skill: markRaw(Star),
  folder: markRaw(Folder),
  terminal: markRaw(Terminal),
  wrench: markRaw(Wrench),
  star: markRaw(Star),
}

/**
 * builtin 命令名 → 专属 lucide 组件（对齐 demo v6 CommandPopover）。
 * key 必须与 core `BUILTIN_COMMAND_ICON_KEYS` 一一对应——新增 builtin 命令时两边同步。
 *  icon 选型依据 demo `.tmp/v6/src/mock/sessions.ts` 的 inline SVG path（lucide v1 等价组件）。
 */
const BUILTIN_COMMAND_ICONS: Record<string, Component> = {
  compact: markRaw(Layers),
  goal: markRaw(Target),
  todos: markRaw(ListChecks),
  permission: markRaw(ShieldCheck),
  schedule: markRaw(CalendarClock),
  'auto-rename': markRaw(Tag),
  subagents: markRaw(Bot),
  workflows: markRaw(Workflow),
  plan: markRaw(NotebookPen),
  'context-engineering': markRaw(SlidersHorizontal),
  'context-stats': markRaw(Gauge),
  'setup-model-policy': markRaw(Grid3x3),
  'setup-statusline': markRaw(PanelTop),
  commit: markRaw(Wand2), // skill 命令但 demo 赋予专属 Wand，覆盖默认 Star
}

/** 统一映射：泛化 key + builtin 命令名 都能查到组件 */
export const SLASH_ICON_COMPONENTS: Record<string, Component> = {
  ...GENERIC_ICON_COMPONENTS,
  ...BUILTIN_COMMAND_ICONS,
}

/**
 * source → icon key（builtin 未命中时的 fallback）。
 * builtin 命令的 icon key 推断走 `iconKeyForCommand`（命令名优先），本函数仅处理纯 source 分支。
 */
export function iconKeyForSource(source: string): string {
  if (source === 'extension') return 'terminal'
  if (source === 'skill') return 'star'
  return 'wrench'
}

/**
 * 命令专属 icon key 推断已在 core 实现（builtin 命令名优先，否则 source 泛化），
 * 本文件上方 `export { iconKeyForCommand } from '@xyz-agent/core'` re-export。
 */
