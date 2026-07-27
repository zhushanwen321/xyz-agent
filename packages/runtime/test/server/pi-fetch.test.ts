/**
 * W4-TC5: fetchPiBinary 下载流程测试。
 *
 * 覆盖：
 *  TC5.1: resolveAsset 平台/架构映射（结构齐全）
 *  TC5.2: 已存在 binary 跳过下载（幂等）
 *  TC5.3: 下载失败（HTTP 404）→ 抛清晰错误（含 npm i -g / XYZ_PI_BIN 指引）
 *  TC5.4: 失败清理临时文件
 *  TC5.5: 冒烟成功路径（mock fetch + tar + execFile 全成功）
 *
 * 策略：vi.mock tar + node:child_process.execFile（pi-fetch 内部 promisify 后用），
 * 注入 tmp dataDir，断言 binary 路径与错误文案。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Mock tar.extract（避免真解压）
vi.mock('tar', () => ({
  extract: vi.fn(),
}))

// Mock node:child_process 的 execFile（pi-fetch 内部 promisify 后调用）
// 顶层 mock：pi-fetch 经 promisify(execFile) 调用，mock 的 execFile 须接受 callback 形式
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFile: vi.fn(),
  }
})

import { extract as tarExtract } from 'tar'
import { execFile } from 'node:child_process'
import { fetchPiBinary, _resolveAssetForTest } from '../../src/server/pi-fetch.js'

const mockTarExtract = vi.mocked(tarExtract)
const mockExecFile = vi.mocked(execFile)

/** 模拟 Web ReadableStream（fetch 返回的 res.body 类型）。 */
function makeReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  }) as ReadableStream<Uint8Array>
}

function makeFetchResponse(body: ReadableStream<Uint8Array> | null, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    body,
  } as unknown as Response
}

/** 设置 execFile 的冒烟响应（pi --version 调用）。callback 形式（与 promisify 兼容）。 */
function setExecFileSmoke(result: { stdout?: string; error?: Error }): void {
  mockExecFile.mockImplementation((_cmd, _args, opts, cb) => {
    const cbFn = (typeof opts === 'function' ? opts : cb) as unknown as (err: Error | null, res?: { stdout: string; stderr: string }) => void
    if (result.error) cbFn(result.error)
    else cbFn(null, { stdout: result.stdout ?? '', stderr: '' })
    return undefined as never
  })
}

describe('W4-TC5: fetchPiBinary 下载流程', () => {
  let originalFetch: typeof globalThis.fetch
  let tmpDataDir: string

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    tmpDataDir = await fs.mkdtemp(join(tmpdir(), 'pi-fetch-test-'))
    mockTarExtract.mockReset()
    mockExecFile.mockReset()
  })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    await fs.rm(tmpDataDir, { recursive: true, force: true })
  })

  it('TC5.1: resolveAsset 平台/架构映射（结构齐全）', () => {
    const asset = _resolveAssetForTest()
    expect(asset).toHaveProperty('asset')
    expect(asset).toHaveProperty('binaryName')
    expect(asset).toHaveProperty('archive')
    expect(['tar.gz', 'zip']).toContain(asset.archive)
    expect(asset.asset.startsWith('pi-')).toBe(true)
  })

  it('TC5.2: 已存在 binary → 跳过下载（幂等）', async () => {
    const asset = _resolveAssetForTest()
    const piDir = join(tmpDataDir, 'pi')
    await fs.mkdir(piDir, { recursive: true })
    const existingPath = join(piDir, asset.binaryName)
    await fs.writeFile(existingPath, 'fake-binary')

    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await fetchPiBinary(tmpDataDir)
    expect(result).toBe(existingPath)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockTarExtract).not.toHaveBeenCalled()
  })

  it('TC5.3: 下载失败（HTTP 404）→ 抛清晰错误含 npm i -g / XYZ_PI_BIN 指引', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeFetchResponse(null, false, 404),
    ) as unknown as typeof globalThis.fetch

    const err = await fetchPiBinary(tmpDataDir).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Failed to setup pi binary/)
    expect((err as Error).message).toMatch(/npm i -g @earendil-works\/pi-coding-agent/)
    expect((err as Error).message).toMatch(/XYZ_PI_BIN/)
  })

  it('TC5.4: 失败后清理临时下载文件', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeFetchResponse(null, false, 404),
    ) as unknown as typeof globalThis.fetch

    try {
      await fetchPiBinary(tmpDataDir)
    } catch {
      // 预期抛错
    }
    const tmpArchive = join(tmpDataDir, 'pi', '.download.tmp')
    expect(existsSync(tmpArchive)).toBe(false)
  })

  it('TC5.5: 冒烟成功路径（mock fetch + tar + execFile 全成功）', async () => {
    const asset = _resolveAssetForTest()
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeFetchResponse(makeReadableStream([new Uint8Array([1, 2, 3, 4])])),
    ) as unknown as typeof globalThis.fetch

    // mock tar.extract 侧效：模拟解压出 pi/pi 二进制
    mockTarExtract.mockImplementation(async () => {
      const piDir = join(tmpDataDir, 'pi')
      const nested = join(piDir, 'pi')
      await fs.mkdir(nested, { recursive: true })
      await fs.writeFile(join(nested, process.platform === 'win32' ? 'pi.exe' : 'pi'), 'real-binary')
      return undefined
    })

    // mock execFile 冒烟成功
    setExecFileSmoke({ stdout: 'pi 0.80.3\n' })

    const result = await fetchPiBinary(tmpDataDir)
    const expectedPath = join(tmpDataDir, 'pi', asset.binaryName)
    expect(result).toBe(expectedPath)
    expect(existsSync(expectedPath)).toBe(true)
    // 冒烟被调用
    expect(mockExecFile).toHaveBeenCalled()
  })

  it('TC5.6: 冒烟失败（pi --version 报错）→ 抛清晰错误', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeFetchResponse(makeReadableStream([new Uint8Array([1, 2])])),
    ) as unknown as typeof globalThis.fetch
    mockTarExtract.mockImplementation(async () => {
      const piDir = join(tmpDataDir, 'pi')
      const nested = join(piDir, 'pi')
      await fs.mkdir(nested, { recursive: true })
      await fs.writeFile(join(nested, 'pi'), 'real-binary')
      return undefined
    })
    setExecFileSmoke({ error: new Error('exited with code 1') })

    const err = await fetchPiBinary(tmpDataDir).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Failed to setup pi binary/)
    expect((err as Error).message).toMatch(/pi smoke test failed/)
  })

  it('TC5.7: 冒烟返回空输出 → 视为失败', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeFetchResponse(makeReadableStream([new Uint8Array([1, 2])])),
    ) as unknown as typeof globalThis.fetch
    mockTarExtract.mockImplementation(async () => {
      const piDir = join(tmpDataDir, 'pi')
      const nested = join(piDir, 'pi')
      await fs.mkdir(nested, { recursive: true })
      await fs.writeFile(join(nested, 'pi'), 'real-binary')
      return undefined
    })
    setExecFileSmoke({ stdout: '' })

    await expect(fetchPiBinary(tmpDataDir)).rejects.toThrow(/pi smoke test failed/)
  })
})
