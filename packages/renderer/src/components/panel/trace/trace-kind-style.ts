/**
 * trace kind badge 色板（trace-tab-demo.html .k-* 同源）。
 * 行组件与 inspector 共用（禁散落第二份）。
 */
import type { TraceRowKind } from '@xyz-agent/core/domain/session-trace'

/** kind badge 类映射：消息中性 / 系统信息蓝 / 压缩与 NOTICE 警黄 / lifecycle 与 DATA 弱描边 / 损坏行危险红。 */
export const KIND_BADGE_CLASS: Record<TraceRowKind, string> = {
  SESSION: 'bg-surface-2 text-neutral-mid',
  SYSTEM: 'bg-info-soft text-info',
  USER: 'bg-surface-hover text-neutral-fg',
  ASSISTANT: 'bg-surface-hover text-neutral-fg',
  TOOL: 'bg-surface-2 text-neutral-mid',
  BASH: 'bg-surface-2 text-neutral-mid',
  NOTICE: 'bg-warn-soft text-warn',
  COMPACTED: 'bg-warn-soft text-warn',
  BRANCH: 'bg-info-soft text-info',
  LIFECYCLE: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
  DATA: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
  BOUNDARY: 'bg-surface-2 text-neutral-mid',
  MALFORMED: 'bg-danger-soft text-danger',
}
