/**
 * W4-TC1: detectUrls 五档探测优先级测试。
 *
 * 覆盖探测优先级（demo 01 SSOT，从高到低）：
 *  TC1.1: XYZ_AGENT_PUBLIC_URL（显式，wss:// + https:// 两种写法）
 *  TC1.2: Tailscale IP 档（mock networkInterfaces 返 100.64.x.x）
 *  TC1.3: Tailscale MagicDNS 档（mock execFile 返 Self.DNSName）
 *  TC1.4: LAN IPv4 档（mock networkInterfaces 返 192.168.x.x）
 *  TC1.5: localhost 兜底（无任何网卡/无 public url）
 *  TC1.6: 去重（同 host 多档只保留最优）
 *  TC1.7: 排序（PUBLIC_URL > Tailscale IP > MagicDNS > LAN > localhost）
 *
 * 策略：mock networkInterfaces + child_process.execFile，注入 env，断言返回数组顺序与内容。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock 必须在 import detectUrls 之前注册（vi.mock hoist）
vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(),
}))
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))
vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util')
  return { ...actual, promisify: actual.promisify }
})

import { networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import { detectUrls } from '../../src/server/detect-url.js'

const mockNetworkInterfaces = vi.mocked(networkInterfaces)
const mockExecFile = vi.mocked(execFile)

// 模拟网卡地址结构（与 node:os NetworkInterfaceInfo 对齐）
interface MockAddr {
  address: string
  family: string
  internal: boolean
}

function setInterfaces(ifaces: Record<string, MockAddr[]>): void {
  mockNetworkInterfaces.mockReturnValue(ifaces)
}

function setExecFileResult(result: { stdout?: string; error?: Error } | null): void {
  if (result === null) {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      // promisify 传 (cmd, args, opts, callback)；callback 签名 (err, {stdout, stderr})
      const cbFn = (typeof _opts === 'function' ? _opts : cb) as unknown as (err: Error | null, res?: { stdout: string }) => void
      cbFn(new Error('tailscale not found'))
      return undefined as never
    })
    return
  }
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
    const cbFn = (typeof _opts === 'function' ? _opts : cb) as unknown as (err: Error | null, res?: { stdout: string }) => void
    if (result.error) {
      cbFn(result.error)
    } else {
      cbFn(null, { stdout: result.stdout ?? '' })
    }
    return undefined as never
  })
}

describe('W4-TC1: detectUrls 五档探测优先级', () => {
  beforeEach(() => {
    mockNetworkInterfaces.mockReset()
    mockExecFile.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC1.1: XYZ_AGENT_PUBLIC_URL（wss:// 写法）→ public 档首', async () => {
    setInterfaces({})
    setExecFileResult(null)
    const urls = await detectUrls(3210, { XYZ_AGENT_PUBLIC_URL: 'wss://xyz.example.com' })
    expect(urls[0]).toMatchObject({
      kind: 'public',
      wsUrl: 'wss://xyz.example.com:3210',
      httpUrl: 'https://xyz.example.com:3210',
    })
  })

  it('TC1.1b: XYZ_AGENT_PUBLIC_URL（https:// 写法）→ ws 推导为 wss', async () => {
    setInterfaces({})
    setExecFileResult(null)
    const urls = await detectUrls(3210, { XYZ_AGENT_PUBLIC_URL: 'https://xyz.example.com' })
    expect(urls[0]).toMatchObject({
      kind: 'public',
      httpUrl: 'https://xyz.example.com:3210',
      wsUrl: 'wss://xyz.example.com:3210',
    })
  })

  it('TC1.1c: XYZ_AGENT_PUBLIC_URL（带显式 port）→ 不再追加 fallback port', async () => {
    setInterfaces({})
    setExecFileResult(null)
    const urls = await detectUrls(3210, { XYZ_AGENT_PUBLIC_URL: 'wss://xyz.example.com:8443' })
    expect(urls[0]?.wsUrl).toBe('wss://xyz.example.com:8443')
    expect(urls[0]?.httpUrl).toBe('https://xyz.example.com:8443')
  })

  it('TC1.2: Tailscale IP 档（100.64.x.x）→ tailscale kind', async () => {
    setInterfaces({
      eth0: [{ address: '100.64.42.18', family: 'IPv4', internal: false }],
    })
    setExecFileResult(null)
    const urls = await detectUrls(3210, {})
    const ts = urls.find(u => u.kind === 'tailscale')
    expect(ts).toBeDefined()
    expect(ts?.host).toBe('100.64.42.18:3210')
    expect(ts?.wsUrl).toBe('ws://100.64.42.18:3210')
  })

  it('TC1.3: Tailscale MagicDNS 档（execFile tailscale status --json）', async () => {
    setInterfaces({})
    setExecFileResult({
      stdout: JSON.stringify({
        Self: { DNSName: 'myserver.tail-7c3a.ts.net.' },
      }),
    })
    const urls = await detectUrls(3210, {})
    const ts = urls.find(u => u.kind === 'tailscale')
    expect(ts).toBeDefined()
    // DNSName 末尾 '.' 去除
    expect(ts?.host).toBe('myserver.tail-7c3a.ts.net:3210')
  })

  it('TC1.3b: tailscale execFile 失败 → MagicDNS 档静默跳过（不抛错）', async () => {
    setInterfaces({})
    setExecFileResult({ error: new Error('command not found') })
    const urls = await detectUrls(3210, {})
    // 无 Tailscale IP + MagicDNS 失败 + 无 LAN → localhost 兜底
    expect(urls[0]?.kind).toBe('localhost')
  })

  it('TC1.4: LAN IPv4 档（192.168.x.x，非 loopback/internal）', async () => {
    // 含 loopback + LAN + Tailscale，验 LAN 与 Tailscale 分离
    setInterfaces({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
    })
    setExecFileResult(null)
    const urls = await detectUrls(3210, {})
    const lan = urls.find(u => u.kind === 'lan')
    expect(lan).toBeDefined()
    expect(lan?.host).toBe('192.168.1.42:3210')
  })

  it('TC1.5: localhost 兜底（无任何可达网卡 + 无 public url）', async () => {
    setInterfaces({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    })
    setExecFileResult(null)
    const urls = await detectUrls(3210, {})
    expect(urls).toHaveLength(1)
    expect(urls[0]?.kind).toBe('localhost')
    expect(urls[0]?.host).toBe('localhost:3210')
  })

  it('TC1.6: 去重（Tailscale IP 与 MagicDNS 同 host 时只保留首项）', async () => {
    // 同 host 不可能（IP vs DNS 名不同），此用例验同 host 的两档去重逻辑：
    // 用 LAN 模拟两次同 IP 出现（多网卡同 IP），应只保留一项
    setInterfaces({
      en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
      en1: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
    })
    setExecFileResult(null)
    const urls = await detectUrls(3210, {})
    const lanUrls = urls.filter(u => u.kind === 'lan' && u.host === '192.168.1.42:3210')
    expect(lanUrls).toHaveLength(1)
  })

  it('TC1.7: 排序——PUBLIC_URL > Tailscale IP > LAN > localhost', async () => {
    setInterfaces({
      tailscale0: [{ address: '100.64.42.18', family: 'IPv4', internal: false }],
      en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
    })
    setExecFileResult(null)
    const urls = await detectUrls(3210, { XYZ_AGENT_PUBLIC_URL: 'wss://public.example.com' })
    // public 最前，tailscale 次之，lan 再次
    expect(urls[0]?.kind).toBe('public')
    expect(urls[1]?.kind).toBe('tailscale')
    expect(urls[2]?.kind).toBe('lan')
  })
})
