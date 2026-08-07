/**
 * 可达 URL 自动探测（wave4 远程化 server CLI）。
 *
 * 探测优先级（demo 01 SSOT，从高到低）：
 *  1. XYZ_AGENT_PUBLIC_URL（用户显式指定，公网反代场景必填）
 *  2. Tailscale IP（networkInterfaces 找 tailscale0 / 100.64.0.0/10 段）
 *  3. Tailscale MagicDNS 名（execFile `tailscale status --json` 取 Self.DNSName）
 *  4. 局域网 IPv4（非 loopback、internal=false）
 *  5. localhost 兜底
 *
 * 返回所有命中的档位（去重，排序最优在前），printStartup 默认只输出 [0]，
 * `--print-all-urls` 输出全部。
 *
 * 协议推导（与 demo 01 三场景对齐）：
 *  - XYZ_AGENT_PUBLIC_URL 显式带协议（wss:// / https:// / ws:// / http://）→ 原样用，
 *    httpUrl 用同 scheme 的 http 对应（https↔http，wss→https host）。
 *  - 其余档位默认 plain ws:// / http://（Tailscale WireGuard 已加密、LAN 受信网络）。
 *
 * 设计取舍：
 *  - detectUrls 改 async（MagicDNS 需 execFile）。
 *  - execFile 失败（tailscale 未装/未登录/超时）静默跳过该档位，不抛错——探测是 best-effort。
 *  - Tailscale IP 档（第 2 档）与 MagicDNS 档（第 3 档）分离：有些机器只装 Tailscale
 *    客户端但未开 MagicDNS，IP 仍可达；MagicDNS 名更易读但需 DNS 解析。
 */
import { networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Tailscale CGNAT IPv4 段（100.64.0.0/10）：检测 Tailscale 网卡归属。
 *  范围 100.64.0.0 - 100.127.255.255，用第二段 [64,128) 判定。 */
const TAILSCALE_IPV4_PREFIX = '100.'
/** Tailscale IPv6 ULA 前缀（fd7a:115c:a1e0:b1a::/64，MagicDNS 推导时用）。 */
const TAILSCALE_IPV6_PREFIX = 'fd7a:115c:a1e0:'
/** execFile tailscale status 的超时（ms）。失败静默跳过 MagicDNS 档。 */
const TAILSCALE_CMD_TIMEOUT_MS = 2000
/** execFile tailscale status 的最大 stdout 缓冲（1MB，status --json 实际 <100KB）。 */
// eslint-disable-next-line no-magic-numbers -- 1MB maxBuffer 是 execFile 防 OOM 的标准值
const TAILSCALE_MAX_BUFFER = 1024 * 1024
/** localhost 兜底 host（探测全失败时用）。 */
const LOCALHOST = 'localhost'

export type UrlKind = 'public' | 'tailscale' | 'lan' | 'localhost'

export interface DetectedUrl {
  kind: UrlKind
  /** 连接 host：纯 host 或 host:port（PUBLIC_URL 带 port 时保留）。 */
  host: string
  /** 浏览器直达 URL（http(s)://host:port/#token=...）。 */
  httpUrl: string
  /** WebSocket URL（ws(s)://host:port），客户端 WS 连接用。 */
  wsUrl: string
}

/** Tailscale status --json 的最小视图（只取 Self.DNSName，其余忽略）。 */
interface TailscaleStatus {
  Self?: { DNSName?: string }
}

/**
 * 探测所有可达 URL（按优先级排序，最优在前）。
 *
 * @param port runtime WS 监听端口（URL 中拼用）
 * @param env 可选 env 注入（测试用），缺省读 process.env
 */
export async function detectUrls(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DetectedUrl[]> {
  const found: DetectedUrl[] = []
  const seenHosts = new Set<string>()

  const add = (url: DetectedUrl): void => {
    if (seenHosts.has(url.host)) return
    seenHosts.add(url.host)
    found.push(url)
  }

  // ── 1. XYZ_AGENT_PUBLIC_URL（显式）──────────────────────────────
  const publicUrl = env.XYZ_AGENT_PUBLIC_URL
  if (publicUrl) {
    add(deriveFromPublicUrl(publicUrl, port))
  }

  // ── 2. Tailscale IP（networkInterfaces 找 100.64.0.0/10）─────────
  const tailscaleIps = findTailscaleIps()
  for (const ip of tailscaleIps) {
    add(makeUrl('tailscale', ip, port))
  }

  // ── 3. Tailscale MagicDNS（execFile tailscale status --json）─────
  const magicDns = await detectTailscaleMagicDns()
  if (magicDns) {
    add(makeUrl('tailscale', magicDns, port))
  }

  // ── 4. 局域网 IPv4（非 loopback、internal=false）─────────────────
  const lanIps = findLanIpv4s()
  for (const ip of lanIps) {
    add(makeUrl('lan', ip, port))
  }

  // ── 5. localhost 兜底（探测全失败时用）──────────────────────────
  if (found.length === 0) {
    add(makeUrl('localhost', LOCALHOST, port))
  }

  return found
}

/**
 * 从 XYZ_AGENT_PUBLIC_URL 推导 DetectedUrl。支持 ws(s):// 与 http(s):// 两种写法：
 *  - ws(s)://host[:port] → wsUrl=原值，httpUrl=http(s)://host[:port]
 *  - http(s)://host[:port] → httpUrl=原值，wsUrl=ws(s)://host[:port]
 * port 缺省（标准端口 80/443）时不附加。
 */
function deriveFromPublicUrl(raw: string, fallbackPort: number): DetectedUrl {
  const trimmed = raw.trim().replace(/\/+$/, '')
  let wsUrl: string
  let httpUrl: string
  let host: string

  const wsMatch = /^(wss?):\/\/([^/]+)/i.exec(trimmed)
  const httpMatch = /^(https?):\/\/([^/]+)/i.exec(trimmed)

  if (wsMatch) {
    const wsScheme = wsMatch[1].toLowerCase()
    const wsHost = wsMatch[2]
    wsUrl = `${wsScheme}://${wsHost}`
    // wss → https，ws → http，host 段保持不变（已含可能的 port）
    const httpScheme = wsScheme === 'wss' ? 'https' : 'http'
    httpUrl = `${httpScheme}://${wsHost}`
    host = wsHost
  } else if (httpMatch) {
    const httpScheme = httpMatch[1].toLowerCase()
    const httpHost = httpMatch[2]
    httpUrl = `${httpScheme}://${httpHost}`
    const wsScheme = httpScheme === 'https' ? 'wss' : 'ws'
    wsUrl = `${wsScheme}://${httpHost}`
    host = httpHost
  } else {
    // 无 scheme 兜底：当作 wss host 处理（公网反代常见写法）
    wsUrl = `wss://${trimmed}`
    httpUrl = `https://${trimmed}`
    host = trimmed
  }

  // 若 URL 未含 port，附加 fallbackPort（标准端口省略语义由调用方在 UI 处理，
  // 此处 URL 字符串保持显式 port 便于复制粘贴直接可用）。
  if (!host.includes(':')) {
    wsUrl = `${wsUrl}:${fallbackPort}`
    httpUrl = `${httpUrl}:${fallbackPort}`
    host = `${host}:${fallbackPort}`
  }

  return { kind: 'public', host, httpUrl, wsUrl }
}

/** 构造 DetectedUrl（plain http/ws，Tailscale/LAN/localhost 共用）。 */
function makeUrl(kind: UrlKind, host: string, port: number): DetectedUrl {
  const hostWithPort = `${host}:${port}`
  return {
    kind,
    host: hostWithPort,
    httpUrl: `http://${hostWithPort}`,
    wsUrl: `ws://${hostWithPort}`,
  }
}

/**
 * 扫描网卡找 Tailscale IP（100.64.0.0/10 IPv4 + fd7a:115c:a1e0: IPv6）。
 * 同时覆盖 tailscale0/utun 网卡名与 IP 段两种判据（不同 OS 网卡名不一）。
 */
function findTailscaleIps(): string[] {
  const result: string[] = []
  const ifaces = networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue
    // 网卡名提示（tailscale0 Linux、utun* macOS），但不强依赖——IP 段是主判据。
    const nameHintsTailcale = name === 'tailscale0' || /^utun\d+$/.test(name)
    for (const a of addrs) {
      if (a.family !== 'IPv4' && a.family !== 'IPv6') continue
      const isTsIp = isTailscaleIpv4(a.address)
        || a.address.startsWith(TAILSCALE_IPV6_PREFIX)
      if (isTsIp || (nameHintsTailcale && !a.internal)) {
        result.push(a.address)
      }
    }
  }
  // IPv4 优先于 IPv6（URL 更短、兼容性更好）
  return result.sort((a, b) => (a.includes(':') ? 1 : 0) - (b.includes(':') ? 1 : 0))
}

/** 扫描网卡找 LAN IPv4（非 loopback、internal=false）。 */
function findLanIpv4s(): string[] {
  const result: string[] = []
  const ifaces = networkInterfaces()
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue
    for (const a of addrs) {
      if (a.family !== 'IPv4') continue
      if (a.internal) continue
      if (isLoopbackIpv4(a.address)) continue
      // 排除 Tailscale 段（已由第 2 档处理）
      if (isTailscaleIpv4(a.address)) continue
      result.push(a.address)
    }
  }
  return result
}

/** 判 IPv4 loopback（127.0.0.0/8）。 */
function isLoopbackIpv4(ip: string): boolean {
  return ip.startsWith('127.')
}

/** 判 Tailscale CGNAT IPv4（100.64.0.0/10：第二段 [64,128)）。 */
function isTailscaleIpv4(ip: string): boolean {
  if (!ip.startsWith(TAILSCALE_IPV4_PREFIX)) return false
  const secondOctet = parseInt(ip.split('.')[1] ?? '0', 10)
  // eslint-disable-next-line no-magic-numbers -- CGNAT 第二段边界 64/128 是 RFC6598 定义
  return secondOctet >= 64 && secondOctet < 128
}

/**
 * execFile `tailscale status --json` 取 Self.DNSName（MagicDNS 名）。
 * DNSName 末尾常带 '.'（FQDN），去之。失败（未装/未登录/超时）静默返回 undefined。
 *
 * 注意：此调用是可选增强——不装 Tailscale 的机器直接跳过该档，不影响其余探测。
 */
async function detectTailscaleMagicDns(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'tailscale',
      ['status', '--json'],
      { timeout: TAILSCALE_CMD_TIMEOUT_MS, maxBuffer: TAILSCALE_MAX_BUFFER },
    )
    const status = JSON.parse(stdout) as TailscaleStatus
    const name = status.Self?.DNSName?.replace(/\.+$/, '')
    return name || undefined
  } catch {
    // tailscale 未装 / 未登录 / 超时 / 非 Tailscale 环境 → 静默跳过
    return undefined
  }
}
