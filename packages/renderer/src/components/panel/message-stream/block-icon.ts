import type { Component } from 'vue'
import { Brain, Bot, Wrench, XCircle, ChevronRight } from '@lucide/vue'
import type { ToolCallStatus } from '@xyz-agent/shared'

/**
 * block-icon.ts —— trace 块图标映射（W2 创建，W3 接入 Block.vue/BlockSubagent.vue）。
 *
 * 10 类 BlockIconKind 对应 trace 流里所有块的图标语义。getBlockIcon 按「状态 > 类型」的
 * 固定优先级决策（running 覆盖一切 → failed → subagent → workflow → toolName 映射）。
 *
 * W2 阶段映射值用现状图标（Brain/Bot/Wrench/XCircle/ChevronRight），保证 W2 接入后零视觉变化。
 * W3 阶段改 BLOCK_ICON_LUCIDE 为 H 最终图标（lightbulb/users/terminal/book-open/pencil/
 * list-checks/alert-triangle/arrow-right），并填 RUNNING_LOADER_SVG 双环 loader SVG。
 *
 * 归属：本文件是图标决策的 SSOT（IF1/IF2 契约）。消费方拿 BlockIconKind 后，running 用
 * RUNNING_LOADER_SVG，其余用 BLOCK_ICON_LUCIDE[kind]。
 */
export type BlockIconKind =
  | 'thinking' | 'tool-read' | 'tool-bash' | 'tool-edit' | 'tool-other'
  | 'subagent' | 'workflow' | 'running' | 'failed' | 'text'

/** toolName → tool 细分类映射（未命中的 toolName 走 'tool-other'） */
const TOOL_ICON_MAP: Record<string, BlockIconKind> = {
  read: 'tool-read',
  bash: 'tool-bash',
  edit: 'tool-edit',
  write: 'tool-edit',
}

/**
 * 决策块图标种类。优先级（覆盖关系）：
 *   status==='running' → running（运行中态覆盖一切，用 loader 动画）
 *   status==='error'   → failed
 *   isSubagent         → subagent
 *   isWorkflow         → workflow
 *   否则               → TOOL_ICON_MAP[toolName] ?? 'tool-other'
 */
export function getBlockIcon(
  toolName: string,
  status: ToolCallStatus,
  isSubagent: boolean,
  isWorkflow: boolean,
): BlockIconKind {
  if (status === 'running') return 'running'
  if (status === 'error') return 'failed'
  if (isSubagent) return 'subagent'
  if (isWorkflow) return 'workflow'
  return TOOL_ICON_MAP[toolName] ?? 'tool-other'
}

/**
 * BlockIconKind → lucide 组件映射（不含 running——running 用 RUNNING_LOADER_SVG）。
 * W2 用现状图标，W3 改为 H 最终值（见各 // W3 注释）。
 */
export const BLOCK_ICON_LUCIDE: Record<Exclude<BlockIconKind, 'running'>, Component> = {
  thinking: Brain,
  'tool-read': Wrench,      // W3 换 BookOpen
  'tool-bash': Wrench,      // W3 换 Terminal
  'tool-edit': Wrench,      // W3 换 Pencil
  'tool-other': Wrench,
  subagent: Bot,            // W3 换 Users
  workflow: Wrench,         // W3 换 ListChecks
  failed: XCircle,          // W3 换 AlertTriangle
  text: ChevronRight,       // W3 保持或换 ArrowRight
}

/**
 * running 态双环 loader SVG（W2 占位空串，消费方 W2 阶段不接入——
 * W3 填外环 opacity 0.35 + 内实心点的双环 SVG，1.4s 线性旋转，accent 蓝，尊重 prefers-reduced-motion）。
 */
export const RUNNING_LOADER_SVG: string = ''
