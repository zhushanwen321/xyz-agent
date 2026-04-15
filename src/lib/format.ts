/** 格式化 token 数量为人类可读字符串。零值返回空字符串（用于 v-if 隐藏）。 */
export function formatTokens(n: number): string {
  if (n === 0) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** 格式化 token 数量，零值也显示（用于 StatusBar 等总是需要展示的场景）。 */
export function formatTokensAlways(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** 格式化毫秒为人类可读时长 */
export function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 1_000).toFixed(1)}s`
}
