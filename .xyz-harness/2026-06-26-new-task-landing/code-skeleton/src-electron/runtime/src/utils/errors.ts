/**
 * errors 工具桩（git-service.ts execSafe 引用 toErrorMessage）。
 * [leaf] 纯计算：未知错误 → 可读字符串。完整实现在 src-electron/runtime/src/utils/errors.ts（未改动）。
 */
export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : '未知错误'
}
