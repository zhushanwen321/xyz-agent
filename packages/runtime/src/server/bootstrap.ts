/**
 * 服务端首启输出（wave4 远程化 server CLI）。
 *
 * 安全约束（强制 #6）：本文件**全部**用 `process.stdout.write`，**禁用** `console.*`。
 * 原因：runtime index.ts 的 initLogger 会 monkey-patch console，使所有 console.*
 * tee 到 <dataDir>/logs/runtime-YYYY-MM-DD.log。首启输出含 token 明文，token 落盘是
 * 安全风险（任何能读日志的进程/用户都能拿到访问凭据）。process.stdout.write 不经 patch，
 * 直出终端，不落盘。
 *
 * 输出格式对齐 demo 01（docs/page-design/remote/01-server-bootstrap.html）：
 *  ✓ xyz-agent server started (runtime vX.Y.Z, pi vX.Y.Z)
 *  ℹ  detected network: <kind> (<host>)
 *  ℹ  token generated: <tokenFile> (mode 0600)   /   ℹ  open mode (no token)
 *  ℹ  pi executable: <path>
 *  [1] 浏览器直达: <httpUrl>/#token=<token>
 *  [2] APP 一键连接: xyz-agent://connect?url=<encoded wsUrl>&token=<token>
 *  [3] 手动: URL: <wsUrl>  Token: <token>
 *  [QR]（printQr 时）
 *  ℹ  WS server listening on <host>:<port>
 *
 * printAllUrls=false（默认）只输出 detectedUrls[0] 的 [1][2][3]，
 * true 输出全部档位。
 */
import qrcode from 'qrcode-terminal'
import type { DetectedUrl, UrlKind } from './detect-url.js'

export interface StartupInfo {
  detectedUrls: DetectedUrl[]
  /** 认证 token（开放模式 undefined）。 */
  token?: string
  /** token 文件路径（"token generated: <path>" 行用）。 */
  tokenFile?: string
  serverVersion: string
  piVersion?: string
  /** pi 可执行文件路径（"pi executable: <path>" 行用）。 */
  piPath?: string
  /** 是否打印二维码（--print-qr）。 */
  printQr?: boolean
  /** QR 内容模式：browser（默认）= [1] URL，deep-link = [2] URL。 */
  qrMode?: 'browser' | 'deep-link'
  /** 是否输出全部探测档位（默认 false 只输出最优）。 */
  printAllUrls?: boolean
  /** WS 监听 host:port（最后一行 "WS server listening on" 用）。 */
  listenHost?: string
  listenPort?: number
}

const TOKEN_FILE_MODE = '0600'

/**
 * 打印首启引导信息到 stdout。token 经 process.stdout.write 直出，不经 console patch 落盘。
 */
export function printStartup(info: StartupInfo): void {
  const out: string[] = []

  // ── 头部：started + 网络探测 + token + pi ─────────────────────────
  const piPart = info.piVersion ? `, pi v${info.piVersion}` : ''
  out.push(`✓ xyz-agent server started (runtime v${info.serverVersion}${piPart})`)

  const primary = info.detectedUrls[0]
  if (primary) {
    out.push(`ℹ  detected network: ${kindLabel(primary.kind)} (${primary.host})`)
  }

  if (info.token) {
    const filePart = info.tokenFile ? `: ${info.tokenFile} (mode ${TOKEN_FILE_MODE})` : ' (mode 0600)'
    out.push(`ℹ  token generated${filePart}`)
  } else {
    out.push('ℹ  open mode (no token)')
  }

  if (info.piPath) {
    out.push(`ℹ  pi executable: ${info.piPath}`)
  }

  out.push('') // 空行分隔

  // ── 连接信息 [1][2][3] ─────────────────────────────────────────────
  const urlsToShow = info.printAllUrls ? info.detectedUrls : info.detectedUrls.slice(0, 1)
  for (const url of urlsToShow) {
    if (urlsToShow.length > 1) {
      out.push(`── ${kindLabel(url.kind)} (${url.host}) ──`)
    }
    const tokenHash = info.token ? `/#token=${info.token}` : ''
    out.push(`[1] 浏览器直达: ${url.httpUrl}${tokenHash}`)
    const encodedWs = encodeURIComponent(url.wsUrl)
    const tokenQuery = info.token ? `&token=${info.token}` : ''
    out.push(`[2] APP 一键连接: xyz-agent://connect?url=${encodedWs}${tokenQuery}`)
    out.push(`[3] 手动: URL: ${url.wsUrl}  Token: ${info.token ?? '(open mode)'}`)
    out.push('')
  }

  // ── QR 码（--print-qr）────────────────────────────────────────────
  if (info.printQr && primary) {
    const qrContent = info.qrMode === 'deep-link'
      ? `xyz-agent://connect?url=${encodeURIComponent(primary.wsUrl)}${info.token ? `&token=${info.token}` : ''}`
      : `${primary.httpUrl}${info.token ? `/#token=${info.token}` : ''}`
    const qrLabel = info.qrMode === 'deep-link' ? 'deep link [2]' : '浏览器直达 [1]'
    out.push(`[QR] 二维码 · 内容 = ${qrLabel}`)
    const qrText = renderQr(qrContent)
    if (qrText) {
      out.push(qrText)
    } else {
      out.push('  (QR 渲染失败)')
    }
    out.push('')
  }

  // ── 尾部：listening 行（可选）─────────────────────────────────────
  if (info.listenHost && info.listenPort) {
    const hint = primary?.kind === 'tailscale'
      ? '(Tailscale 自动探测，无 TLS — WireGuard 已加密)'
      : primary?.kind === 'lan'
        ? '(LAN, no TLS)'
        : ''
    out.push(`ℹ  WS server listening on ${info.listenHost}:${info.listenPort}${hint ? ` ${hint}` : ''}`)
  }

  process.stdout.write(out.join('\n') + '\n')
}

/**
 * 把 Kind 映射为人类可读的网络名（对齐 demo 01 "detected network:" 行）。
 * Tailscale 与 public（公网反代）语义独立，分别标注。
 */
function kindLabel(kind: UrlKind): string {
  switch (kind) {
    case 'public': return 'Public reverse proxy'
    case 'tailscale': return 'Tailscale'
    case 'lan': return 'LAN'
    case 'localhost': return 'localhost'
  }
}

/**
 * 用 qrcode-terminal 渲染二维码（small 模式，省终端行数）。
 * generate 是同步调用 cb 的，包装成返回字符串便于注入输出数组。
 * 失败（输入过长等）返回 undefined。
 */
function renderQr(content: string): string | undefined {
  let result: string | undefined
  try {
    qrcode.generate(content, { small: true }, (qr: string) => {
      result = qr
    })
  } catch {
    result = undefined
  }
  return result
}
