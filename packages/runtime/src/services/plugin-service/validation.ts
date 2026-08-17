/**
 * 插件 RPC 入口参数校验器（SEC-A5 路径注入防御）
 *
 * 插件 Worker 经 RPC 传入的字符串标识符（sessionId / pluginId / key / scope）
 * 此前以 `params.sessionId as string` 直接下发，并 join 进持久化路径——
 * `../../` 可越出数据目录读/写/删任意 .json。本模块在 API 入口层收敛校验：
 * 凡会进入文件系统路径的标识符必须过 asSafeKey（字符集白名单），从语法上
 * 排除路径分隔符与 `..` 遍历序列。store 层另有 path.resolve 深度防御兜底
 * （session-data-store.ts / plugin-storage.ts），两层独立生效。
 *
 * 错误契约：抛 `errorWithCode(message, 'INVALID_<FIELD>')`——code 由字段名
 * 推导（sessionId → INVALID_SESSION_ID，pluginId → INVALID_PLUGIN_ID，
 * key → INVALID_KEY，scope → INVALID_SCOPE）；message 含字段名、白名单
 * regex 与实际收到的值（截断），插件作者可直接照此修正。
 */

import { errorWithCode } from '../../utils/errors.js'

/**
 * 标识符白名单：字母/数字/`.`/`_`/`-`，1-128 字符。
 * `/`、`\`、`:`、空白与 `..` 遍历序列均不在字符集内。
 * 128 与 pluginId/sessionId 的现有取值空间（npm 包名、session id）兼容。
 */
const SAFE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** 错误 message 回显违规值的截断长度：防恶意超长输入把错误信息/日志撑爆 */
const VALUE_PREVIEW_MAX_CHARS = 64

/** camelCase 字段名 → 错误码：'sessionId' → 'INVALID_SESSION_ID' */
function fieldToErrorCode(field: string): string {
  return `INVALID_${field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
}

/** 违规值的可读回显：string 带引号（超长截断），非 string 只报类型，避免泄露整包内容 */
function previewValue(value: unknown): string {
  if (typeof value === 'string') {
    const shown = value.length > VALUE_PREVIEW_MAX_CHARS
      ? `${value.slice(0, VALUE_PREVIEW_MAX_CHARS)}…(truncated)`
      : value
    return `"${shown}"`
  }
  return `(${typeof value})`
}

/**
 * 断言 value 是 string，否则抛 `INVALID_<FIELD>` 结构化错误。
 *
 * 不含字符集/长度约束——用于只需「确实是字符串」的场景（后续单元扩展使用）。
 */
export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw errorWithCode(
      `Invalid ${field}: expected a string but received ${previewValue(value)}. Pass the ${field} as a JSON string in the RPC params.`,
      fieldToErrorCode(field),
    )
  }
  return value
}

/**
 * 断言 value 是 string 且 UTF-8 字节数不超过 maxBytes，否则抛 `INVALID_<FIELD>`。
 *
 * 长度上限由调用方按域定值（后续单元扩展使用）。
 */
export function asBoundedString(value: unknown, field: string, maxBytes: number): string {
  const str = asString(value, field)
  const bytes = Buffer.byteLength(str, 'utf-8')
  if (bytes > maxBytes) {
    throw errorWithCode(
      `Invalid ${field}: length ${bytes} bytes exceeds the ${maxBytes}-byte limit (${previewValue(str)}). Shorten the ${field} and retry.`,
      fieldToErrorCode(field),
    )
  }
  return str
}

/**
 * 断言 value 是符合白名单的安全标识符，否则抛 `INVALID_<FIELD>` 结构化错误。
 *
 * 用于会进入文件系统路径的标识符（sessionId / pluginId / key / scope）：
 * 字符集白名单从语法上排除路径分隔符与 `..` 遍历，1-128 字符上限防止
 * 超长键名进入文件名与内存 size 跟踪。
 */
export function asSafeKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_KEY_PATTERN.test(value)) {
    throw errorWithCode(
      `Invalid ${field} ${previewValue(value)}: must match /^[A-Za-z0-9._-]{1,128}$/ `
      + `(1-128 chars of letters, digits, '.', '_', '-'; path separators and '..' are not allowed). `
      + `Pass the ${field} exactly as provided by the host API, without path segments.`,
      fieldToErrorCode(field),
    )
  }
  return value
}
