/**
 * format-utils.ts —— trace 块耗时格式化（formatDuration + 常量）。
 *
 * 从 Block.vue / BlockSubagent.vue 抽出（W2 carry-over DRY 消除）。两处对耗时的
 * 格式化逻辑完全一致，收敛到 SSOT 避免漂移。
 *
 * 接受 unknown（meta 字段 / progress 快照字段类型宽松），非数字返回空串。
 */

/** 时长格式化阈值 */
export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60000

/** 格式化时长（ms→s/min）。接受 unknown（meta 字段 / progress 快照字段类型宽松） */
export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  if (ms >= MS_PER_MINUTE) return `${(ms / MS_PER_MINUTE).toFixed(1)}min`
  if (ms >= MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(0)}s`
  return `${ms}ms`
}
