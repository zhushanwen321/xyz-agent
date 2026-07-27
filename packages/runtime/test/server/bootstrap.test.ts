/**
 * W4-TC2: printStartup 输出格式 + token 不经 console 落盘。
 *
 * 关键安全断言（强制 #6）：
 *  - consoleSpy 不被调用（防 initLogger monkey-patch 后 token 落盘日志）
 *  - token 仅出现在 process.stdout.write（终端可见，但不入日志文件）
 *
 * 覆盖：
 *  TC2.1: 基本输出（started/detected/token/pi 三行 + [1][2][3] 连接信息）
 *  TC2.2: token 不经 console（核心安全断言）
 *  TC2.3: 开放模式（token undefined）→ "open mode (no token)" 行
 *  TC2.4: printAllUrls=true 输出全部档位（每档 [1][2][3]）
 *  TC2.5: printQr=true 输出 QR 码（browser 模式内容=[1]）
 *  TC2.6: qrMode='deep-link' QR 内容=[2] deep link
 *  TC2.7: listening 行（含 Tailscale 提示文案）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { printStartup, type StartupInfo } from '../../src/server/bootstrap.js'
import type { DetectedUrl } from '../../src/server/detect-url.js'

function makeDetectedUrl(kind: DetectedUrl['kind'], host: string, port: number): DetectedUrl {
  const hostWithPort = `${host}:${port}`
  return {
    kind,
    host: hostWithPort,
    httpUrl: `http://${hostWithPort}`,
    wsUrl: `ws://${hostWithPort}`,
  }
}

function makeStartup(overrides: Partial<StartupInfo> = {}): StartupInfo {
  return {
    detectedUrls: [makeDetectedUrl('tailscale', '100.64.42.18', 3210)],
    token: 'secret-token-xyz',
    tokenFile: '~/.xyz-agent/token',
    serverVersion: '0.9.0',
    piVersion: '0.80.3',
    piPath: '/usr/local/bin/pi',
    listenHost: '0.0.0.0',
    listenPort: 3210,
    ...overrides,
  }
}

describe('W4-TC2: printStartup 输出 + token 安全', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>
  let captured: string

  beforeEach(() => {
    captured = ''
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
      captured += String(data)
      return true
    })
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC2.1: 基本输出含 started / detected / token generated / pi / [1][2][3]', () => {
    printStartup(makeStartup())
    expect(captured).toContain('✓ xyz-agent server started (runtime v0.9.0, pi v0.80.3)')
    expect(captured).toContain('ℹ  detected network: Tailscale (100.64.42.18:3210)')
    expect(captured).toContain('ℹ  token generated: ~/.xyz-agent/token (mode 0600)')
    expect(captured).toContain('ℹ  pi executable: /usr/local/bin/pi')
    expect(captured).toMatch(/\[1\] 浏览器直达: http:\/\/100\.64\.42\.18:3210\/#token=secret-token-xyz/)
    expect(captured).toMatch(/\[2\] APP 一键连接: xyz-agent:\/\/connect\?url=/)
    expect(captured).toMatch(/\[3\] 手动: URL: ws:\/\/100\.64\.42\.18:3210  Token: secret-token-xyz/)
  })

  it('TC2.2【核心安全】: token 不经 console（防 initLogger patch 落盘日志）', () => {
    printStartup(makeStartup({ token: 'top-secret-token' }))
    // console.log/error/warn 均不应被调用（token 只能经 stdout 直出终端）
    expect(consoleLogSpy).not.toHaveBeenCalled()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
    // 但 token 必须出现在 stdout（终端可见）
    expect(stdoutSpy.mock.calls.some(c => String(c[0]).includes('top-secret-token'))).toBe(true)
  })

  it('TC2.3: 开放模式（token undefined）→ "open mode (no token)" 行', () => {
    printStartup(makeStartup({ token: undefined }))
    expect(captured).toContain('ℹ  open mode (no token)')
    // [3] 行 Token 字段显示 (open mode)
    expect(captured).toMatch(/Token: \(open mode\)/)
    // 不应出现 #token= hash（无 token 时不拼）
    expect(captured).not.toContain('#token=')
  })

  it('TC2.4: printAllUrls=true 输出全部档位（每档独立 [1][2][3]）', () => {
    const info = makeStartup({
      detectedUrls: [
        makeDetectedUrl('public', 'public.example.com', 3210),
        makeDetectedUrl('lan', '192.168.1.42', 3210),
      ],
      printAllUrls: true,
    })
    // public 用 https（来自 makeDetectedUrl 默认 http，但 kind 标记不同——此处验档位分隔头）
    printStartup(info)
    // 两档都应有分隔头
    expect(captured).toContain('── Public reverse proxy')
    expect(captured).toContain('── LAN')
    // public 档的 [1] 与 lan 档的 [1] 都存在
    expect(captured).toContain('http://public.example.com:3210')
    expect(captured).toContain('http://192.168.1.42:3210')
  })

  it('TC2.5: printQr=true 输出 QR 码（browser 模式默认内容=[1] URL）', () => {
    printStartup(makeStartup({ printQr: true }))
    expect(captured).toContain('[QR] 二维码')
    expect(captured).toContain('内容 = 浏览器直达 [1]')
    // qrcode-terminal small 模式会输出非空 ASCII（含 █ 或 块字符）
    expect(captured.length).toBeGreaterThan(200)
  })

  it('TC2.6: qrMode=deep-link → QR 内容=[2] deep link', () => {
    printStartup(makeStartup({ printQr: true, qrMode: 'deep-link' }))
    expect(captured).toContain('内容 = deep link [2]')
  })

  it('TC2.7: listening 行含 Tailscale 加密提示（primary kind=tailscale）', () => {
    printStartup(makeStartup({ detectedUrls: [makeDetectedUrl('tailscale', '100.64.42.18', 3210)] }))
    expect(captured).toContain('ℹ  WS server listening on 0.0.0.0:3210')
    expect(captured).toContain('Tailscale 自动探测')
    expect(captured).toContain('WireGuard 已加密')
  })

  it('TC2.7b: listening 行含 LAN 提示（primary kind=lan）', () => {
    printStartup(makeStartup({ detectedUrls: [makeDetectedUrl('lan', '192.168.1.42', 3210)] }))
    expect(captured).toContain('LAN, no TLS')
  })
})
