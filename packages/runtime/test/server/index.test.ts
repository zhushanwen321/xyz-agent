/**
 * W4-TC7/TC8: server/index.ts 参数解析 + 命令分发测试。
 *
 * 覆盖：
 *  TC7.1~7.7: parseServerArgs 参数解析（默认值/--flag value/--flag=value/布尔/枚举/env/未知 flag）
 *  TC8.1~8.6: run() 命令分发（--help/--version/--reset-token/--show-token/正常启动）
 *
 * 策略：
 *  - parseServerArgs 直接调用导出函数（argv + env 注入），无需 process.argv mutation。
 *  - run() 经 vi.mock 替换所有外部副作用模块（main/fetchPiBinary/detectUrls/printStartup/tokenManager），
 *    mock process.exit（不真退出），直接 await run() 驱动（run 内读 process.argv）。
 *  - run() 经 isMainEntry guard 不会被 import 时副作用执行，测试显式 await run()。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock 所有外部副作用模块（避免真启动 runtime / 真下载 pi）
vi.mock('../../src/index.js', () => ({
  main: vi.fn(),
}))
vi.mock('../../src/transport/token.js', () => ({
  createTokenManager: vi.fn(),
}))
vi.mock('../../src/infra/pi/process-manager.js', () => ({
  findPiExecutable: vi.fn(() => 'pi'),
}))
vi.mock('../../src/server/detect-url.js', () => ({
  detectUrls: vi.fn(() => []),
}))
vi.mock('../../src/server/bootstrap.js', () => ({
  printStartup: vi.fn(),
}))
vi.mock('../../src/server/pi-fetch.js', () => ({
  fetchPiBinary: vi.fn(() => '/fake/pi'),
}))
vi.mock('../../src/services/plugin-service/plugin-version-checker.js', () => ({
  getAppVersion: vi.fn(() => '0.9.0'),
}))
vi.mock('@xyz-agent/shared/paths', () => ({
  getDataDir: vi.fn(() => '/tmp/test-data-dir'),
}))

import { main } from '../../src/index.js'
import { createTokenManager, type TokenManager } from '../../src/transport/token.js'
import { printStartup } from '../../src/server/bootstrap.js'
import { fetchPiBinary } from '../../src/server/pi-fetch.js'
import { detectUrls } from '../../src/server/detect-url.js'
import { findPiExecutable } from '../../src/infra/pi/process-manager.js'
import { parseServerArgs, run, printHelp } from '../../src/server/index.js'

const mockMain = vi.mocked(main)
const mockCreateTokenManager = vi.mocked(createTokenManager)
const mockPrintStartup = vi.mocked(printStartup)
const mockFetchPiBinary = vi.mocked(fetchPiBinary)
const mockDetectUrls = vi.mocked(detectUrls)
const mockFindPiExecutable = vi.mocked(findPiExecutable)

function makeMockTokenManager(overrides: Partial<TokenManager> = {}): TokenManager {
  return {
    load: vi.fn(() => ({ enabled: false })),
    generate: vi.fn(() => 'generated-token'),
    persist: vi.fn(),
    verify: vi.fn(() => true),
    ...overrides,
  } as unknown as TokenManager
}

describe('W4-TC7: parseServerArgs 参数解析', () => {
  beforeEach(() => {
    // 清 env 避免污染
    delete process.env.XYZ_AGENT_HOST
    delete process.env.XYZ_AGENT_PORT
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC7.1: 默认值（无 env 无 argv）', () => {
    const args = parseServerArgs([])
    expect(args.host).toBe('0.0.0.0')
    expect(args.port).toBe(3210)
    expect(args.printQr).toBe(false)
    expect(args.qrMode).toBe('browser')
    expect(args.printAllUrls).toBe(false)
    expect(args.resetToken).toBe(false)
    expect(args.showToken).toBe(false)
    expect(args.version).toBe(false)
    expect(args.help).toBe(false)
  })

  it('TC7.2: --flag value 形式', () => {
    const args = parseServerArgs(['--host', '127.0.0.1', '--port', '4000', '--token-file', '/tmp/tk'])
    expect(args.host).toBe('127.0.0.1')
    expect(args.port).toBe(4000)
    expect(args.tokenFile).toBe('/tmp/tk')
  })

  it('TC7.3: --flag=value 形式', () => {
    const args = parseServerArgs(['--host=0.0.0.0', '--port=9999', '--token-file=/tmp/x'])
    expect(args.host).toBe('0.0.0.0')
    expect(args.port).toBe(9999)
    expect(args.tokenFile).toBe('/tmp/x')
  })

  it('TC7.4: --print-qr / --qr deep-link / --print-all-urls', () => {
    const args = parseServerArgs(['--print-qr', '--qr', 'deep-link', '--print-all-urls'])
    expect(args.printQr).toBe(true)
    expect(args.qrMode).toBe('deep-link')
    expect(args.printAllUrls).toBe(true)
  })

  it('TC7.4b: --qr=deep-link 等号形式', () => {
    const args = parseServerArgs(['--qr=deep-link'])
    expect(args.qrMode).toBe('deep-link')
  })

  it('TC7.4c: --qr 浏览器模式（缺省与非 deep-link 值）', () => {
    const args = parseServerArgs(['--qr', 'browser'])
    expect(args.qrMode).toBe('browser')
  })

  it('TC7.5: --serve-web <dist> / --reset-token / --show-token', () => {
    const args = parseServerArgs(['--serve-web', '/dist/web', '--reset-token'])
    expect(args.serveWeb).toBe('/dist/web')
    expect(args.resetToken).toBe(true)

    const args2 = parseServerArgs(['--show-token'])
    expect(args2.showToken).toBe(true)
  })

  it('TC7.6: XYZ_AGENT_HOST / XYZ_AGENT_PORT env 覆盖默认', () => {
    process.env.XYZ_AGENT_HOST = '1.2.3.4'
    process.env.XYZ_AGENT_PORT = '5555'
    const args = parseServerArgs([])
    expect(args.host).toBe('1.2.3.4')
    expect(args.port).toBe(5555)
    delete process.env.XYZ_AGENT_HOST
    delete process.env.XYZ_AGENT_PORT
  })

  it('TC7.7: 未知 flag 静默忽略（不报错）', () => {
    const args = parseServerArgs(['--unknown-flag', 'value', '--host', 'real'])
    expect(args.host).toBe('real')
    // 未知 flag 不影响其它解析
    expect(args.port).toBe(3210)
  })

  it('TC7.8: -h / -v 短形式', () => {
    expect(parseServerArgs(['-h']).help).toBe(true)
    expect(parseServerArgs(['-v']).version).toBe(true)
  })
})

describe('W4-TC8: 命令分发（run 流程）', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let exitMock: ReturnType<typeof vi.spyOn>
  let originalArgv: string[]
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    vi.clearAllMocks()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // mock process.exit：抛 sentinel error 中断 run 后续流程（exit 后不应继续执行）
    exitMock = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`__EXIT_${code ?? 0}__`)
    })
    originalArgv = process.argv
    originalEnv = { ...process.env }
    delete process.env.XYZ_AGENT_HOST
    delete process.env.XYZ_AGENT_PORT
  })
  afterEach(() => {
    vi.restoreAllMocks()
    process.argv = originalArgv
    process.env = originalEnv
  })

  /** 设 process.argv 模拟 CLI 调用（slice(2) = flags）。 */
  function setArgv(flags: string[]): void {
    process.argv = ['node', '/path/to/server.cjs', ...flags]
  }

  it('TC8.1: --help → printHelp + exit(0)', async () => {
    setArgv(['--help'])
    await expect(run()).rejects.toThrow(/__EXIT_0__/)
    expect(exitMock).toHaveBeenCalledWith(0)
    expect(stdoutSpy.mock.calls.some(c => String(c[0]).includes('xyz-agent-runtime'))).toBe(true)
    expect(stdoutSpy.mock.calls.some(c => String(c[0]).includes('--host'))).toBe(true)
  })

  it('TC8.2: --version → stdout 输出版本 + exit(0)', async () => {
    setArgv(['--version'])
    await expect(run()).rejects.toThrow(/__EXIT_0__/)
    expect(exitMock).toHaveBeenCalledWith(0)
    expect(stdoutSpy.mock.calls.some(c => String(c[0]).includes('v0.9.0'))).toBe(true)
  })

  it('TC8.3: --reset-token → tm.generate + persist + exit(0)', async () => {
    const mockTm = makeMockTokenManager({
      generate: vi.fn(() => 'new-token-123'),
      persist: vi.fn(),
    })
    mockCreateTokenManager.mockReturnValue(mockTm)
    setArgv(['--reset-token'])
    await expect(run()).rejects.toThrow(/__EXIT_0__/)
    expect(exitMock).toHaveBeenCalledWith(0)
    expect(mockTm.generate).toHaveBeenCalled()
    expect(mockTm.persist).toHaveBeenCalledWith('new-token-123')
    // 新 token 经 stdout 输出
    expect(stdoutSpy.mock.calls.some(c => String(c[0]).includes('new-token-123'))).toBe(true)
  })

  it('TC8.4: --show-token enabled → stdout 输出 token + exit(0)', async () => {
    const mockTm = makeMockTokenManager({
      load: vi.fn(() => ({ enabled: true, token: 'existing-token' })),
    })
    mockCreateTokenManager.mockReturnValue(mockTm)
    setArgv(['--show-token'])
    await expect(run()).rejects.toThrow(/__EXIT_0__/)
    expect(exitMock).toHaveBeenCalledWith(0)
    expect(stdoutSpy.mock.calls.some(c => String(c[0]).includes('existing-token'))).toBe(true)
  })

  it('TC8.5: --show-token open mode → stdout 输出 "open mode" + exit(0)', async () => {
    const mockTm = makeMockTokenManager({
      load: vi.fn(() => ({ enabled: false })),
    })
    mockCreateTokenManager.mockReturnValue(mockTm)
    setArgv(['--show-token'])
    await expect(run()).rejects.toThrow(/__EXIT_0__/)
    expect(exitMock).toHaveBeenCalledWith(0)
    expect(stdoutSpy.mock.calls.some(c => String(c[0]).includes('open mode'))).toBe(true)
  })

  it('TC8.6: 正常启动 → 首启 token 生成 + detectUrls + printStartup + main 调用', async () => {
    const mockTm = makeMockTokenManager({
      load: vi.fn(() => ({ enabled: false })),
      generate: vi.fn(() => 'startup-token'),
      persist: vi.fn(),
    })
    mockCreateTokenManager.mockReturnValue(mockTm)
    mockDetectUrls.mockResolvedValue([{ kind: 'localhost', host: 'localhost:3210', httpUrl: 'http://localhost:3210', wsUrl: 'ws://localhost:3210' }])
    mockMain.mockResolvedValue(undefined)
    setArgv(['--host', '0.0.0.0', '--port', '3210'])

    await run()

    expect(mockTm.generate).toHaveBeenCalled()
    expect(mockTm.persist).toHaveBeenCalledWith('startup-token')
    expect(mockDetectUrls).toHaveBeenCalledWith(3210)
    expect(mockFetchPiBinary).toHaveBeenCalled()
    expect(mockPrintStartup).toHaveBeenCalledWith(expect.objectContaining({
      token: 'startup-token',
      serverVersion: '0.9.0',
      listenHost: '0.0.0.0',
      listenPort: 3210,
    }))
    expect(mockMain).toHaveBeenCalledWith(expect.objectContaining({
      host: '0.0.0.0',
      port: 3210,
      serveWeb: undefined,
    }))
  })

  it('TC8.7: 正常启动 + 已有 token → 不生成新 token，复用 existing', async () => {
    const mockTm = makeMockTokenManager({
      load: vi.fn(() => ({ enabled: true, token: 'existing-token-456' })),
      generate: vi.fn(),
      persist: vi.fn(),
    })
    mockCreateTokenManager.mockReturnValue(mockTm)
    mockDetectUrls.mockResolvedValue([])
    mockMain.mockResolvedValue(undefined)
    setArgv([])

    await run()

    // 已有 token 不再 generate/persist
    expect(mockTm.generate).not.toHaveBeenCalled()
    expect(mockTm.persist).not.toHaveBeenCalled()
    // printStartup 用 existing token
    expect(mockPrintStartup).toHaveBeenCalledWith(expect.objectContaining({
      token: 'existing-token-456',
    }))
  })

  it('TC8.8: pi setup 失败 → stderr 输出但不阻塞启动', async () => {
    const mockTm = makeMockTokenManager({
      load: vi.fn(() => ({ enabled: false })),
      generate: vi.fn(() => 'tok'),
      persist: vi.fn(),
    })
    mockCreateTokenManager.mockReturnValue(mockTm)
    mockFindPiExecutable.mockReturnValue('pi')
    mockFetchPiBinary.mockRejectedValue(new Error('network down'))
    mockDetectUrls.mockResolvedValue([])
    mockMain.mockResolvedValue(undefined)
    setArgv([])

    await run()

    // pi 失败信息经 stderr
    expect(stderrSpy.mock.calls.some(c => String(c[0]).includes('pi setup failed'))).toBe(true)
    // main 仍被调用（不阻塞）
    expect(mockMain).toHaveBeenCalled()
  })

  it('TC8.9: --serve-web <dist> → main 收到 serveWeb 参数', async () => {
    const mockTm = makeMockTokenManager({
      load: vi.fn(() => ({ enabled: false })),
      generate: vi.fn(() => 'tok'),
      persist: vi.fn(),
    })
    mockCreateTokenManager.mockReturnValue(mockTm)
    mockDetectUrls.mockResolvedValue([])
    mockMain.mockResolvedValue(undefined)
    setArgv(['--serve-web', '/path/to/dist'])

    await run()

    expect(mockMain).toHaveBeenCalledWith(expect.objectContaining({
      serveWeb: '/path/to/dist',
    }))
  })

  it('TC8.10: printHelp 输出含所有选项说明', () => {
    printHelp()
    const output = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(output).toContain('--host')
    expect(output).toContain('--port')
    expect(output).toContain('--token-file')
    expect(output).toContain('--print-qr')
    expect(output).toContain('--serve-web')
    expect(output).toContain('--reset-token')
    expect(output).toContain('--show-token')
    expect(output).toContain('--version')
    expect(output).toContain('--help')
    expect(output).toContain('XYZ_AGENT_PUBLIC_URL')
  })
})
