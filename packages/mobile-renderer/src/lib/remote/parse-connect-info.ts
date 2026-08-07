/**
 * parseConnectionInfo + classifyNetworkKind —— 粘贴连接信息四格式解析 + 网络类型启发式识别。
 *
 * 设计决策（spec §三 + §2.2）：
 * - 四格式短路匹配（WC5）：deep-link → http-url → ws-url → url-token-lines，命中即返回。
 * - URL 解析优先用 URL 构造器 + URLSearchParams；仅 url-token-lines 多行用行级正则。
 * - 校验宽松：url 必须 ws(s)://（http-url 推导后），token 仅查非空（P0 前部署兼容 hex）。
 * - 解析失败静默（ES1）：全不命中返回 {error:'unrecognized'}，不抛异常（剪贴板探测路径同规则）。
 * - classifyNetworkKind 畸形/空输入兜底 'public'（ES4，不抛错）。
 *
 * 依赖方向：依赖 types.ts；无下游（被 RemotePasteTab.vue / 剪贴板探测 / manual helper 复用）。
 */
import type {
  ConnectionInfoFormat,
  NetworkKind,
  ParsedConnectionInfo,
} from './types'

// ── 网络类型启发式（spec §2.2）──────────────────────────────────

/** IPv4 八位组数量 */
const IPV4_OCTET_COUNT = 4
/** IPv4 八位组最大值（0-255） */
const IPV4_OCTET_MAX = 255
/** IPv4 八位组拼接基数（每位 256 进制） */
const IPV4_OCTET_RADIX = 256

/** Tailscale CGNAT 网段 100.64.0.0/10 起止（用于判定 tailscale） */
const CGNAT_START = ipv4ToInt('100.64.0.0')
const CGNAT_END = ipv4ToInt('100.127.255.255')
/** 私网 10/8 起止 */
const PRIVATE_10_START = ipv4ToInt('10.0.0.0')
const PRIVATE_10_END = ipv4ToInt('10.255.255.255')
/** 私网 172.16/12 起止 */
const PRIVATE_172_START = ipv4ToInt('172.16.0.0')
const PRIVATE_172_END = ipv4ToInt('172.31.255.255')
/** 私网 192.168/16 起止 */
const PRIVATE_192_START = ipv4ToInt('192.168.0.0')
const PRIVATE_192_END = ipv4ToInt('192.168.255.255')

/** IPv4 字符串转 32 位无符号 int（畸形返回 NaN） */
function ipv4ToInt(ip: string): number {
  const parts = ip.split('.')
  if (parts.length !== IPV4_OCTET_COUNT) return Number.NaN
  let result = 0
  for (const part of parts) {
    const n = Number.parseInt(part, 10)
    if (!Number.isInteger(n) || n < 0 || n > IPV4_OCTET_MAX) return Number.NaN
    result = result * IPV4_OCTET_RADIX + n
  }
  return result
}

/**
 * 按主机识别网络类型（spec §2.2 启发式）。
 *
 * 判定顺序：localhost → tailscale（.ts.net 后缀或 100.64/10 CGNAT）→ lan（10/8、172.16/12、192.168/16）
 *          → public。
 * host 先 normalize（trim + lowercase）；畸形/空 → 'public'（ES4 兜底，不抛错）。
 *
 * @param host URL 主机部分（域名或 IP，不含端口）
 */
export function classifyNetworkKind(host: string): NetworkKind {
  const normalized = (host ?? '').trim().toLowerCase()
  if (!normalized) return 'public'

  // localhost：保留名或 127/8 回环
  if (normalized === 'localhost') return 'localhost'
  if (/^127\./.test(normalized)) return 'localhost'

  // tailscale：.ts.net 后缀
  if (normalized.endsWith('.ts.net')) return 'tailscale'

  // IP 形态才走网段判定
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) {
    const n = ipv4ToInt(normalized)
    if (Number.isNaN(n)) return 'public'
    if (n >= CGNAT_START && n <= CGNAT_END) return 'tailscale'
    if (n >= PRIVATE_10_START && n <= PRIVATE_10_END) return 'lan'
    if (n >= PRIVATE_172_START && n <= PRIVATE_172_END) return 'lan'
    if (n >= PRIVATE_192_START && n <= PRIVATE_192_END) return 'lan'
    return 'public'
  }

  // 非回环、非 tailscale、非私网 IP 的域名/IP → public
  return 'public'
}

// ── 四格式解析（spec §三）──────────────────────────────────────

/** deep-link 前缀 */
const DEEP_LINK_PREFIX = 'xyz-agent://connect'

/** 从 URL 提取 host（去端口），失败返回空串 */
function hostOf(urlStr: string): string {
  try {
    return new URL(urlStr).hostname
  } catch {
    return ''
  }
}

/** 构造命中结果（统一补 networkKind） */
function buildParsed(
  format: ConnectionInfoFormat,
  url: string,
  token?: string,
): ParsedConnectionInfo {
  const result: ParsedConnectionInfo = {
    url,
    format,
    networkKind: classifyNetworkKind(hostOf(url)),
  }
  if (token && token.length > 0) {
    result.token = token
  }
  return result
}

/**
 * 解析粘贴的连接信息文本，自动识别四种格式（spec §三）。
 *
 * 匹配顺序（短路）：
 * 1. deep-link：`xyz-agent://connect?url=<enc>&token=<...>` —— URLSearchParams 解码 url
 * 2. http-url：`http(s)://host[:port]/...#token=...` —— http→ws / https→wss 推导，token 取 hash 参数
 * 3. ws-url：`ws(s)://host[:port][/path]` 单行 —— url 命中即返（token 缺失按 ES2 不报 error）
 * 4. url-token-lines：多行含 `URL: ws://...` + `Token: ...` —— 行级正则两行
 *
 * 全不命中 → `{ error: 'unrecognized' }`（ES1 静默不抛）。
 *
 * @param input 粘贴框任意文本
 */
export function parseConnectionInfo(input: string): ParsedConnectionInfo {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return { error: 'unrecognized' }

  // 1. deep-link
  if (trimmed.startsWith(DEEP_LINK_PREFIX)) {
    return parseDeepLink(trimmed)
  }

  // 2. http-url（http:// 或 https://）
  if (/^https?:\/\//i.test(trimmed)) {
    return parseHttpUrl(trimmed)
  }

  // 3. ws-url（ws:// 或 wss://，单行，trim 后命中即返）
  if (/^wss?:\/\//i.test(trimmed)) {
    return parseWsUrl(trimmed)
  }

  // 4. url-token-lines（多行含 URL: / Token:）
  const linesResult = parseUrlTokenLines(trimmed)
  if (linesResult) return linesResult

  return { error: 'unrecognized' }
}

/** deep-link 解析：URLSearchParams 取 url（已 decodeURIComponent）+ token */
function parseDeepLink(input: string): ParsedConnectionInfo {
  // 用 URL 构造器解析 query（custom protocol 下某些环境 URL 不支持，降级手工切）
  let params: URLSearchParams
  const qIndex = input.indexOf('?')
  if (qIndex >= 0) {
    params = new URLSearchParams(input.slice(qIndex + 1))
  } else {
    return { error: 'unrecognized' }
  }
  const url = params.get('url') ?? ''
  const token = params.get('token') ?? ''
  // 校验 url 必须 ws(s)://
  if (!/^wss?:\/\//i.test(url)) {
    return { error: 'unrecognized' }
  }
  return buildParsed('deep-link', url, token || undefined)
}

/** http-url 解析：http→ws / https→wss 推导，token 取 hash 参数 */
function parseHttpUrl(input: string): ParsedConnectionInfo {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return { error: 'unrecognized' }
  }
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  // URL.host 自动含端口
  const wsUrl = `${wsProtocol}//${parsed.host}`
  // token 取 hash 参数（#token=abc → 去掉前导 # 后用 URLSearchParams）
  let token: string | undefined
  if (parsed.hash.length > 1) {
    const hashParams = new URLSearchParams(parsed.hash.slice(1))
    token = hashParams.get('token') ?? undefined
  }
  return buildParsed('http-url', wsUrl, token)
}

/** ws-url 解析：单行 ws(s):// URL，token 缺失不报 error（ES2） */
function parseWsUrl(input: string): ParsedConnectionInfo {
  // 仅取首行（粘贴可能带尾部换行/杂物），trim 后作为 url 原文（保留大小写/路径，spec TC9「url 原文经 trim」）
  const firstLine = input.split(/\r?\n/)[0].trim()
  let parsed: URL
  try {
    parsed = new URL(firstLine)
  } catch {
    return { error: 'unrecognized' }
  }
  // 校验确实是 ws(s) scheme（前缀正则已过，URL 构造器二次确认）
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { error: 'unrecognized' }
  }
  // url 字段返回 trim 后的原文（保留大小写与路径），networkKind 由 buildParsed 内部按 host 识别
  return buildParsed('ws-url', firstLine)
}

/** url-token-lines 解析：行级正则提取 URL: 与 Token: 两行，命中返结果否则 null */
function parseUrlTokenLines(input: string): ParsedConnectionInfo | null {
  const urlMatch = input.match(/^\s*URL:\s*(\S+)\s*$/im)
  const tokenMatch = input.match(/^\s*Token:\s*(\S+)\s*$/im)
  if (!urlMatch) return null
  const url = urlMatch[1]
  if (!/^wss?:\/\//i.test(url)) return null
  const token = tokenMatch?.[1]
  return buildParsed('url-token-lines', url, token)
}
