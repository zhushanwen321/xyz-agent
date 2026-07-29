/**
 * workflow 格式化纯函数（W2 wave，从 WorkflowDetail.vue 提取）。
 *
 * 把 callDotClass / phaseDotClass / formatTokens / formatDuration 抽到独立模块，
 * 供 WorkflowDetail.vue（Flows tab 视图 2）和 WorkflowDagView.vue（DAG 视图 A）复用，
 * 避免 formatter 逻辑重复。零 Vue 依赖，可单测。
 *
 * 常量内联（原 WorkflowDetail.vue 的 TOKEN_K_THRESHOLD / MS_PER_SECOND / SECONDS_PER_MINUTE）。
 */
import type { WorkflowAgentCall } from '@xyz-agent/shared'

/**
 * agent call 状态点配色。返回 Tailwind 语义类（映射 CSS 变量，禁止硬编码色值）。
 * - completed → bg-success
 * - failed → bg-danger
 * - running → bg-accent
 * - pending → bg-neutral-dim opacity-40
 */
export function callDotClass(status: WorkflowAgentCall['status']): string {
  switch (status) {
    case 'completed': return 'bg-success'
    case 'failed': return 'bg-danger'
    case 'running': return 'bg-accent'
    default: return 'bg-neutral-dim opacity-40'
  }
}

/**
 * phase 聚合状态点配色（callDotClass 去掉 failed 的简化版，phase 只有 completed/running/pending）。
 * - completed → bg-success
 * - running → bg-accent
 * - pending → bg-neutral-dim opacity-40
 */
export function phaseDotClass(status: 'completed' | 'running' | 'pending'): string {
  switch (status) {
    case 'completed': return 'bg-success'
    case 'running': return 'bg-accent'
    default: return 'bg-neutral-dim opacity-40'
  }
}

/** token 数超过此阈值显示 k 单位 */
const TOKEN_K_THRESHOLD = 1000
/** 毫秒 → 秒 */
const MS_PER_SECOND = 1000
/** 秒 → 分 */
const SECONDS_PER_MINUTE = 60

/**
 * 格式化 token 数。>= 1000 显示为 `${n/1000}k ${unit}`，否则 `${n} ${unit}`。
 * @param tokens token 数
 * @param unit 单位文案（如 i18n 的 'tok' / 'tok in' / 'tok out'）
 */
export function formatTokens(tokens: number, unit: string): string {
  if (tokens >= TOKEN_K_THRESHOLD) return `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k ${unit}`
  return `${tokens} ${unit}`
}

/**
 * 格式化执行耗时（毫秒）。
 * - >= 60s → `${m}m${s}s`
 * - < 60s → `${s}s`
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / MS_PER_SECOND)
  if (seconds >= SECONDS_PER_MINUTE) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${seconds % SECONDS_PER_MINUTE}s`
  return `${seconds}s`
}
