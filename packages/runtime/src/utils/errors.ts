/**
 * 错误处理工具（D14 + D20 + D6）。
 *
 * - `toErrorMessage(e)`：统一 `e instanceof Error ? e.message : String(e)` 样板（D14，
 *   散落 57 处，含 `: e` 与 `: String(e)` 两种漂移）。
 * - `isEnoent(e)`：结构化 ENOENT 判定（D20，统一 `.code === 'ENOENT'` 与脆弱的
 *   `msg.includes('ENOENT')` 字符串匹配两种写法）。
 * - `isNotFound(e)`：tree handler 的「not found」嗅探（D6，统一 5 处
 *   `e.message.includes('not found')` 字符串匹配）。
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

/**
 * 判断错误是否为「not found」类（session-not-active 嗅探，D6）。
 *
 * 统一各处 `e instanceof Error && e.message.includes('not found')`
 * 字符串匹配。抛「not found」串表示 session 未激活，调用方据此降级回复。
 */
export function isNotFound(e: unknown): boolean {
  return e instanceof Error && e.message.includes('not found')
}

/**
 * 构造带 `.code` 属性的 Error（C10）。
 *
 * 统一此前两套写法：`Object.assign(new Error(msg), { code })`（rpc-client）
 * vs `(err as {}).code = code`（plugin-sandbox / session-data-store）。
 * code 可以是 string（'PERMISSION_DENIED' / RPC error code）或 number（JSON-RPC -32xxx）。
 */
export function errorWithCode(message: string, code: string | number): Error & { code: string | number } {
  const err = new Error(message) as Error & { code: string | number }
  err.code = code
  return err
}

/** session 创建/恢复/fork 时 model 未配置的错误码（前端据此引导用户去 Settings 配置） */
export const MODEL_NOT_CONFIGURED = 'MODEL_NOT_CONFIGURED'

/** session 数量达到 MAX_SESSIONS 上限的错误码（wave1 远程化，前端据此提示用户关闭旧 session） */
export const SESSION_LIMIT_REACHED = 'session_limit_reached'

/**
 * terminal 不可用（node-pty native 模块缺失/加载失败）（wave5 远程化）。
 *
 * node-pty 是 native 模块，@xyz-agent/runtime 单独 npm 全局安装时若宿主机缺 build-essential，
 * 加载会抛 MODULE_NOT_FOUND。terminal-service 模块加载不崩（pty=null 哨兵），
 * spawn/write/resize/kill 入口守卫抛此码。
 *
 * 已列入 shared TerminalErrorCode 联合（M2 fix），terminal-message-handler 透传此 code 给前端，
 * 前端可精确分支提示「请安装 build-essential 后重装 node-pty」。
 */
export const TERMINAL_UNAVAILABLE = 'terminal_unavailable'
