/**
 * 错误处理工具（D14 + D20）。
 *
 * - `toErrorMessage(e)`：统一 `e instanceof Error ? e.message : String(e)` 样板（D14，
 *   散落 57 处，含 `: e` 与 `: String(e)` 两种漂移）。
 * - `isEnoent(e)`：结构化 ENOENT 判定（D20，统一 `.code === 'ENOENT'` 与脆弱的
 *   `msg.includes('ENOENT')` 字符串匹配两种写法）。
 */

/**
 * 从任意 thrown 值提取可读的错误信息字符串。
 *
 * Error → `.message`；其它 → `String(value)`。替代散落的
 * `e instanceof Error ? e.message : String(e)` 样板。
 */
export function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 判断错误是否为 ENOENT（文件/目录不存在）。
 *
 * 结构化判定 `code === 'ENOENT'`，替代脆弱的字符串包含匹配
 * `msg.includes('ENOENT')`。对非 Error 或无 code 字段的值返回 false。
 */
export function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null
    && (e as NodeJS.ErrnoException).code === 'ENOENT'
}
