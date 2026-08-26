/**
 * 网络错误分类与 cause 提取工具。
 *
 * 收敛升级链路中三条 fetch 路径（单段 download-asset / 多段 downloadPart / testProxy）
 * 的错误分类逻辑，消除内联分类的重复实现 drift 风险。
 *
 * [HISTORICAL] 设计决策 D1：
 * - extractNetErrorCode 逐层下钻 err.cause，提取 .code 或 message 前缀匹配
 * - isPrivateHost 判定 RFC1918 + IPv6 ULA + loopback（不解析 DNS，hostname 形式落通用文案）
 * - classifyProxyUnreachable = macOS + EHOSTUNREACH + isPrivateHost → UPDATE_PROXY_UNREACHABLE
 *
 * 依赖方向：net-errors → types（UpdateError / UpdateErrorCode / UpdateStage）
 */

import type { UpdateStage } from '@xyz-agent/shared'
import { UpdateError, type UpdateErrorCode } from './types.js'

// ─── cause 提取 ──────────────────────────────────────────────

/**
 * 已知网络错误码（err.code 或 err.message 前缀匹配）。
 *
 * 包含 undici / node:net 常见网络错误码，以及 EHOSTUNREACH（macOS 本地网络权限场景）。
 */
const KNOWN_NET_ERROR_CODES = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
] as const

/**
 * 从 Error 对象中提取网络错误码。
 *
 * undici 的 fetch 抛错时外层 Error 只带 `fetch failed`，真实网络错误挂在 err.cause。
 * 本函数逐层下钻 cause 链，优先返回 .code（如 EHOSTUNREACH），
 * 其次匹配 message 中的已知错误码前缀。
 *
 * @returns 错误码字符串（如 'EHOSTUNREACH'），未识别返回 undefined
 */
export function extractNetErrorCode(err: unknown): string | undefined {
  let current: unknown = err
  // 下钻 cause 链，最多 5 层防循环
  const MAX_DEPTH = 5
  for (let i = 0; i < MAX_DEPTH && current != null; i++) {
    if (current instanceof Error) {
      // 优先 .code（node:net / undici 标准字段）
      const code = (current as NodeJS.ErrnoException).code
      if (code && KNOWN_NET_ERROR_CODES.includes(code as (typeof KNOWN_NET_ERROR_CODES)[number])) {
        return code
      }
      // 次选：message 包含已知错误码
      for (const known of KNOWN_NET_ERROR_CODES) {
        if (current.message.includes(known)) {
          return known
        }
      }
      // 下钻 cause
      current = current.cause
    } else {
      break
    }
  }
  return undefined
}

// ─── 私网地址判定 ──────────────────────────────────────────────

/**
 * 判定 URL 中的 host 是否为私网地址（RFC1918 / IPv6 ULA / loopback）。
 *
 * 不解析 DNS——hostname 形式（如 nas.local / DDNS 域名）直接返回 false，落通用文案。
 * 这是刻意的局限：解析 DNS 会引入新的失败面和延迟，且 hostname 代理场景下
 * 权限指引仍可行动（提示检查代理与权限），只是少了精确指引。
 *
 * @param urlString 代理 URL 字符串（如 'http://192.168.1.202:7890'）
 */
export function isPrivateHost(urlString: string): boolean {
  let hostname: string
  try {
    // URL 构造器处理 scheme://host:port 格式
    hostname = new URL(urlString).hostname
  } catch {
    // 非法 URL，保守返回 false
    return false
  }

  // IPv6：去掉方括号
  const cleanHost = hostname.replace(/^\[|\]$/g, '')

  // IPv4 私网范围
  if (isIPv4Private(cleanHost)) return true

  // IPv6 ULA (fc00::/7) + loopback (::1)
  if (isIPv6Private(cleanHost)) return true

  return false
}

/**
 * 判定 IPv4 地址是否为私网。
 *
 * RFC1918 三段：
 * - 10.0.0.0/8
 * - 172.16.0.0/12
 * - 192.168.0.0/16
 * 加 loopback 127.0.0.0/8
 */
function isIPv4Private(ip: string): boolean {
  // 简单格式校验（不做完整 IPv4 parse，避免引入额外依赖）
  const parts = ip.split('.')
  if (parts.length !== 4) return false

  const octets: number[] = []
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255 || (p !== '0' && p.startsWith('0'))) return false
    octets.push(n)
  }

  // 10.0.0.0/8
  if (octets[0] === 10) return true
  // 172.16.0.0/12 (172.16.x.x ~ 172.31.x.x)
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  // 192.168.0.0/16
  if (octets[0] === 192 && octets[1] === 168) return true
  // 127.0.0.0/8 (loopback)
  if (octets[0] === 127) return true

  return false
}

/**
 * 判定 IPv6 地址是否为私网。
 *
 * - fc00::/7 (ULA，含 fd 前缀的常用子集)
 * - ::1 (loopback)
 * - ::ffff:x.x.x.x (mapped IPv4) 委托 IPv4 判定
 */
function isIPv6Private(ip: string): boolean {
  const lower = ip.toLowerCase()

  // loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true

  // ULA fc00::/7：前 7 位 = 1111110 → fc 或 fd 开头
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or hex form ::ffff:c0a8:101)
  if (lower.startsWith('::ffff:') || lower.startsWith('0:0:0:0:0:ffff:')) {
    const suffix = lower.replace(/^::ffff:/, '').replace(/^0:0:0:0:0:ffff:/, '')
    // Check dotted-decimal form first
    if (isIPv4Private(suffix)) return true
    // Check hex form (URL normalizes ::ffff:192.168.1.1 → ::ffff:c0a8:101)
    const ipv4FromHex = hexMappedToIPv4(suffix)
    if (ipv4FromHex && isIPv4Private(ipv4FromHex)) return true
  }

  return false
}

/**
 * 将 IPv6 mapped hex 形式（如 c0a8:101）转回点分十进制 IPv4。
 *
 * URL 构造器会把 ::ffff:192.168.1.1 规范化为 ::ffff:c0a8:101，
 * 需要反向解析才能判定 IPv4 私网范围。
 */
function hexMappedToIPv4(hex: string): string | undefined {
  // 格式：两组 16 位 hex，冒号分隔
  const parts = hex.split(':')
  if (parts.length !== 2) return undefined
  const high = parseInt(parts[0], 16)
  const low = parseInt(parts[1], 16)
  if (isNaN(high) || isNaN(low)) return undefined
  // 拆回 4 个 8 位 octet
  const o1 = (high >> 8) & 0xff
  const o2 = high & 0xff
  const o3 = (low >> 8) & 0xff
  const o4 = low & 0xff
  return `${o1}.${o2}.${o3}.${o4}`
}

// ─── 代理不可达分类 ──────────────────────────────────────────────

/**
 * 分类代理不可达错误。
 *
 * 判定为 UPDATE_PROXY_UNREACHABLE 的条件（D2）：
 * - macOS (process.platform === 'darwin')
 * - err.code === 'EHOSTUNREACH'
 * - proxyUrl host 是私网地址（RFC1918 + IPv6 ULA + loopback）
 *
 * 不满足条件时返回 false（由调用方走通用网络错误分类）。
 */
export function classifyProxyUnreachable(err: unknown, proxyUrl: string | undefined): boolean {
  if (process.platform !== 'darwin') return false
  const code = extractNetErrorCode(err)
  if (code !== 'EHOSTUNREACH') return false
  if (!proxyUrl) return false
  return isPrivateHost(proxyUrl)
}

// ─── UpdateError 工厂（注入 rawCause）──────────────────────────────

/**
 * 从原始错误构造 UpdateError，注入 rawCause 用于磁盘落盘（D7）。
 *
 * rawCause 是 err.cause 的字符串化，用于 update-error.log 的 rawCause 字段——
 * 即使外层 Error.message 只有 'fetch failed'，落盘后仍可定位根因。
 *
 * @param err 原始错误
 * @param message 用户友好的错误消息（来自映射表）
 * @param stage 升级阶段
 * @param errorCode 错误码
 */
export function wrapUpdateError(
  err: unknown,
  message: string,
  stage: UpdateStage,
  errorCode: UpdateErrorCode,
): UpdateError {
  const rawCause = extractRawCause(err)
  const updateErr = new UpdateError(message, stage, errorCode)
  // 动态注入 rawCause（readonly 字段在构造后赋值）
  Object.defineProperty(updateErr, 'rawCause', {
    value: rawCause,
    writable: false,
    enumerable: true,
    configurable: false,
  })
  return updateErr
}

/**
 * 提取 rawCause 字符串（err.cause 的字符串化）。
 *
 * 递归下钻到最内层 cause，返回其 message 或 String 值。
 * 用于 update-error.log 的 rawCause 字段。
 */
export function extractRawCause(err: unknown): string | undefined {
  let current: unknown = err
  const MAX_DEPTH = 5
  let lastMessage: string | undefined
  for (let i = 0; i < MAX_DEPTH && current != null; i++) {
    if (current instanceof Error) {
      lastMessage = current.message
      current = current.cause
    } else {
      lastMessage = String(current)
      break
    }
  }
  return lastMessage
}
