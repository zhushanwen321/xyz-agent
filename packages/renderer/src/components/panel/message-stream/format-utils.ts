/**
 * format-utils.ts —— trace 块数值格式化（formatTokens/formatDuration + 常量）。
 *
 * 从 Block.vue / BlockSubagent.vue 抽出（W2 carry-over DRY 消除）。两处对 token/耗时
 * 的格式化逻辑完全一致，收敛到 SSOT 避免漂移。
 *
 * 接受 unknown（meta 字段 / progress 快照字段类型宽松），非数字返回空串。
 */

/** token / 时长格式化阈值 */
export const TOKEN_K = 1000
export const TOKEN_M = 1000000
export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60000

/** 格式化 token 数（1000→1k tokens，1000000→1M tokens）。接受 unknown（progress 快照字段类型宽松） */
export function formatTokens(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  if (n >= TOKEN_M) return `${(n / TOKEN_M).toFixed(1)}M tokens`
  if (n >= TOKEN_K) return `${(n / TOKEN_K).toFixed(1)}k tokens`
  return `${n} tokens`
}

/** 格式化时长（ms→s/min）。接受 unknown（meta 字段 / progress 快照字段类型宽松） */
export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  if (ms >= MS_PER_MINUTE) return `${(ms / MS_PER_MINUTE).toFixed(1)}min`
  if (ms >= MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(0)}s`
  return `${ms}ms`
}
