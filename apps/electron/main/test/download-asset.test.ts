/**
 * W3 TDD 测试：download-asset（asset 下载 + sha256 校验）。
 *
 * 覆盖场景 W3TC1-3：
 *   W3TC1 happy path：fetch 返回内容 → 下载完成 → sha256 匹配 → 返回 filePath
 *   W3TC2 sha256 不匹配 → 抛 UpdateIntegrityError + 删半下载文件
 *   W3TC3 sha256 undefined → 降级 size 校验；size 也匹配 → 通过
 *
 * Mock 策略：用真实 fs（temp 目录）+ mock globalThis.fetch 返回固定内容 Response。
 * UPDATE_DIR 经 XYZ_AGENT_DATA_DIR 环境变量重定向到 tmp（必须在 import constants 前设）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/download-asset.test.ts
 */
import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── 批次 5（u5a）原子写序列断言基建 ──────────────────────────────
// 包装 writeFileSync/renameSync 透传真实现并记录调用参数，供「resume-state
// tmp 写入后 rename」序列断言（§3.7.2）。其余 fs 函数原样透传。
// 注意：原函数必须在 vi.mock 工厂闭包内捕获——若经测试文件顶层 import 别名
// 调用，该别名本身已指向 mock（vi.fn），会无限递归（Maximum call stack size exceeded）。
const fsSpy = vi.hoisted(() => ({
  writeCalls: [] as Array<{ path: string; data: string }>,
  renameCalls: [] as Array<{ from: string; to: string }>,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realWriteFileSync = actual.writeFileSync
  const realRenameSync = actual.renameSync
  return {
    ...actual,
    writeFileSync: vi.fn((...a: Parameters<typeof actual.writeFileSync>) => {
      fsSpy.writeCalls.push({ path: String(a[0]), data: String(a[1]) })
      return realWriteFileSync(...a)
    }),
    renameSync: vi.fn((...a: Parameters<typeof actual.renameSync>) => {
      fsSpy.renameCalls.push({ from: String(a[0]), to: String(a[1]) })
      return realRenameSync(...a)
    }),
  }
})

// ── 必须在 import 之前把 UPDATE_DIR 重定向到 tmp ──────────────────
// constants.ts 在 import 时计算 UPDATE_DIR = path.join(getDataDir(), 'update')，
// 而 getDataDir 读 XYZ_AGENT_DATA_DIR。此赋值必须在 import constants（间接被 download-asset import）
// 之前执行。ESM 中顶层语句按 import 顺序执行，故此处放最前面，且下方 import 用动态 import。
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'w3-download-'))
process.env.XYZ_AGENT_DATA_DIR = TMP_DATA_DIR

// 动态 import：确保上面 env 赋值先生效
async function loadModule() {
  return await import('../update/download-asset.js')
}

/** 测试用固定内容 + 预计算 sha256 */
const TEST_CONTENT = Buffer.from('hello world test content for download asset')
const TEST_SHA256 = '85574708fecd188f14f0138f8634d43b889af08a2eaa8abf685870dc08c859e2'

/** 构造一个返回固定内容的 Response（带 content-length 头） */
function makeContentResponse(content: Buffer, status = 200): Response {
  // 转为 Uint8Array：lib.dom 的 BodyInit 接受 Uint8Array 但不接受 Node Buffer
  const body = new Uint8Array(content)
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.length),
    },
  })
}

/** 多段下载测试：12MB 内容（大于 MIN_MULTI_PART_SIZE = 10MB） */
const MULTI_PART_SIZE = 12 * 1024 * 1024
const MULTI_PART_CONTENT = Buffer.alloc(MULTI_PART_SIZE, 0)
// 填充可识别的模式，便于后续断言内容
for (let i = 0; i < MULTI_PART_SIZE; i++) {
  MULTI_PART_CONTENT[i] = i % 256
}

/** 构造 HEAD 探测响应（accept-ranges + content-length） */
function makeHeadResponse(total: number): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
    },
  })
}

/** 构造 Range 响应（content-length + content-range） */
function makeRangeResponse(content: Buffer, start: number, end: number): Response {
  const slice = content.subarray(start, end + 1)
  const body = new Uint8Array(slice)
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(slice.length),
      'Content-Range': `bytes ${start}-${end}/${content.length}`,
      'Accept-Ranges': 'bytes',
    },
  })
}

/** 计算 buffer 的 sha256 hex */
function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('W3: download-asset (W3TC1-3)', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    // 清理 tmp 目录内容（保留目录本身供下次用）
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true })
  })

  // ── W3TC1：happy path（sha256 匹配）────────────────────────────
  it('W3TC1: fetch 内容 → sha256 匹配 → 返回 filePath，文件已 rename 到最终名', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'test-asset.zip',
      downloadUrl: 'https://example.com/test.zip',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    })

    // 返回路径是最终文件名（无 .downloading 后缀）
    expect(result.filePath).toMatch(/test-asset\.zip$/)
    // 文件存在且内容正确
    expect(existsSync(result.filePath)).toBe(true)
    expect(readFileSync(result.filePath)).toEqual(TEST_CONTENT)
    // .downloading 临时文件已清理
    expect(existsSync(`${result.filePath}.downloading`)).toBe(false)
  })

  // ── W3TC2：sha256 不匹配 → 抛 UpdateIntegrityError ──────────────
  it('W3TC2: sha256 不匹配 → 抛 UpdateIntegrityError + 清理半下载文件', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    await expect(downloadAsset({
      name: 'bad-asset.zip',
      downloadUrl: 'https://example.com/bad.zip',
      size: TEST_CONTENT.length,
      sha256: '0'.repeat(64), // 故意错误的 sha256
    })).rejects.toThrow(/sha256 mismatch/)

    // 最终文件不应存在（校验失败被清理）
    const finalPath = path.join(TMP_DATA_DIR, 'update', 'bad-asset.zip')
    expect(existsSync(finalPath)).toBe(false)
    // .downloading 也应被清理
    expect(existsSync(`${finalPath}.downloading`)).toBe(false)
  })

  // ── W3TC3：sha256 undefined → 降级 size 校验通过 ────────────────
  it('W3TC3: sha256 undefined → 降级 size 校验，size 匹配 → 通过', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'no-sha.zip',
      downloadUrl: 'https://example.com/no-sha.zip',
      size: TEST_CONTENT.length,
      // sha256 缺失
    })

    expect(existsSync(result.filePath)).toBe(true)
    expect(readFileSync(result.filePath)).toEqual(TEST_CONTENT)
  })

  // ── W3TC3b：sha256 缺失 + size 不匹配 → 抛 UpdateIntegrityError ─
  it('W3TC3b: sha256 undefined + size 不匹配 → 抛 UpdateIntegrityError', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    await expect(downloadAsset({
      name: 'bad-size.zip',
      downloadUrl: 'https://example.com/bad-size.zip',
      size: 9999, // 故意错误
    })).rejects.toThrow(/size mismatch/)
  })

  // ── W3TC3c：sha256 缺失 + size=0 → 抛 UpdateIntegrityError（BLOCKER 4 回归）
  //    旧实现 `else if (asset.size && asset.size > 0)` 在 size=0 时跳过校验，
  //    攻击者可让下载文件被任意篡改而无校验拦截。修复后二者全缺则拒绝。
  it('W3TC3c: sha256 undefined + size=0 → 抛 UpdateIntegrityError（拒绝无校验）', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    await expect(downloadAsset({
      name: 'no-check.zip',
      downloadUrl: 'https://example.com/no-check.zip',
      size: 0, // size=0（被旧实现当作「无 size」跳过）
      // sha256 缺失
    })).rejects.toThrow(/no integrity check available/)

    // 最终文件不应存在（校验失败被清理）
    const finalPath = path.join(TMP_DATA_DIR, 'update', 'no-check.zip')
    expect(existsSync(finalPath)).toBe(false)
  })

  // ── W3TC4：多段并行下载（大文件 + accept-ranges）──────────────────
  it('W3TC4: 大文件且支持 accept-ranges → 多段并发下载 → 文件完整 + sha256 通过', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = (init?.method as string | undefined) ?? 'GET'
      if (method === 'HEAD') {
        return makeHeadResponse(MULTI_PART_CONTENT.length)
      }
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      if (!match) {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      const start = Number(match[1])
      const end = Number(match[2])
      return makeRangeResponse(MULTI_PART_CONTENT, start, end)
    }) as unknown as typeof globalThis.fetch

    const onProgress = vi.fn()
    const result = await downloadAsset({
      name: 'multipart-asset.zip',
      downloadUrl: 'https://example.com/multipart.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    }, onProgress)

    expect(result.filePath).toMatch(/multipart-asset\.zip$/)
    expect(existsSync(result.filePath)).toBe(true)
    const downloaded = readFileSync(result.filePath)
    expect(downloaded.length).toBe(MULTI_PART_CONTENT.length)
    expect(downloaded.compare(MULTI_PART_CONTENT)).toBe(0)
    // .downloading 与 .part-* 都应清理
    expect(existsSync(`${result.filePath}.downloading`)).toBe(false)
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    expect(existsSync(path.join(updateDir, 'multipart-asset.zip.downloading.part-0'))).toBe(false)
    expect(onProgress).toHaveBeenCalled()
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1]?.[0]
    expect(lastCall).toBe(100)
  })

  // ── W3TC4b：单段大文件下载速度基准（用于对比多段）────────────────
  it('W3TC4b: 大文件但不支持 accept-ranges → 单段下载 → 文件完整', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    globalThis.fetch = vi.fn(async () => makeContentResponse(MULTI_PART_CONTENT)) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'singlepart-asset.zip',
      downloadUrl: 'https://example.com/singlepart.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expect(result.filePath).toMatch(/singlepart-asset\.zip$/)
    const downloaded = readFileSync(result.filePath)
    expect(downloaded.length).toBe(MULTI_PART_CONTENT.length)
    expect(downloaded.compare(MULTI_PART_CONTENT)).toBe(0)
  })

  // ── 进度回调 ────────────────────────────────────────────────────
  it('W3TC1b: onProgress 回调被调用（百分比 0-100）', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch
    const onProgress = vi.fn()

    await downloadAsset({
      name: 'progress.zip',
      downloadUrl: 'https://example.com/progress.zip',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    }, onProgress)

    expect(onProgress).toHaveBeenCalled()
    // 最后一次进度应为 100（content-length 等于实际长度）
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1]?.[0]
    expect(lastCall).toBeLessThanOrEqual(100)
    expect(lastCall).toBeGreaterThanOrEqual(0)
  })
})

/**
 * 多段并行下载错误路径测试（S#10 / test-coverage）。
 *
 * W3TC4 只测 happy path。这里覆盖错误清理路径：某段 Range 请求返回 500 时，
 * downloadPart 抛 UpdateError → downloadAsset rejects → 所有 .part-* 临时文件 +
 * .downloading 合并产物 + resume-state 全部被清理，无磁盘泄漏。
 */
describe('W3 multipart error path (S#10)', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true })
  })

  // ── W3TC5：某段 Range 返回 500 → downloadAsset rejects + 全部临时文件清理 ──
  it('W3TC5: 某段 Range 请求返回 500 → downloadAsset rejects UpdateError，.part-* 与 .downloading 全部清理', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    // 让 part-0 的 Range 请求返回 500，其余段正常；HEAD 探测正常放行多段。
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = (init?.method as string | undefined) ?? 'GET'
      if (method === 'HEAD') {
        return makeHeadResponse(MULTI_PART_CONTENT.length)
      }
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      if (!match) {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      const start = Number(match[1])
      // 第一段（start=0）返回 500 触发 downloadPart 抛错
      if (start === 0) {
        return new Response('Internal Server Error', { status: 500 })
      }
      const end = Number(match[2])
      return makeRangeResponse(MULTI_PART_CONTENT, start, end)
    }) as unknown as typeof globalThis.fetch

    const updateDir = path.join(TMP_DATA_DIR, 'update')
    const assetName = 'multipart-err.zip'
    const downloadingPath = path.join(updateDir, `${assetName}.downloading`)

    await expect(downloadAsset({
      name: assetName,
      downloadUrl: 'https://example.com/multipart-err.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })).rejects.toThrow(/HTTP 500/)

    // 最终文件不存在
    expect(existsSync(path.join(updateDir, assetName))).toBe(false)
    // .downloading 合并产物未残留
    expect(existsSync(downloadingPath)).toBe(false)
    // 所有 .part-* 临时文件均被清理（downloadPart 自清 + downloadMultiPart catch 兜底）
    if (existsSync(updateDir)) {
      const leftovers = readdirSync(updateDir).filter((f) => /\.part-\d+$/.test(f))
      expect(leftovers).toEqual([])
    }
  })
})

/**
 * RM3 多段 Range 违约降级测试（update-reliability 批次 4）。
 *
 * 旧实现 downloadPart 只查 response.ok，服务器/代理忽略 Range 回 200 全量时
 * 四段各下全量 → 合并 4 倍损坏文件 → sha 失败重下死循环。修复后任一段检测到
 * 非 206 或段长不符 → 整批放弃多段，降级单段完整下载，产物必须完整正确。
 */
describe('RM3: multipart Range violation → fallback to single-stream', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  /** body 截短用例的截断长度（远小于段长 3MB，足以触发段长不符） */
  const TRUNCATED_PART_BYTES = 1024

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true })
  })

  /** 断言降级后无 .part-* / .downloading 残留（泄漏检查） */
  function expectNoLeftovers(assetName: string): void {
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) {
      const leftovers = readdirSync(updateDir).filter(
        (f) => f.startsWith(assetName) && (/\.part-\d+$/.test(f) || f.endsWith('.downloading')),
      )
      expect(leftovers).toEqual([])
    }
  }

  /** 断言降级产物是完整正确的文件（若未降级会是 4 倍体积拼接损坏文件且 sha 抛错） */
  function expectIntactFile(filePath: string): void {
    const downloaded = readFileSync(filePath)
    expect(downloaded.length).toBe(MULTI_PART_CONTENT.length)
    expect(downloaded.compare(MULTI_PART_CONTENT)).toBe(0)
  }

  // RM3-1: HEAD 声称支持 Range，但 GET 带 Range 一律回 200 全量（真实世界最典型：
  // 某些代理/CDN 静默剥离 Range 头）。修复前：4 段各收 12MB 全量合并成 48MB 损坏
  // 文件 → sha 失败重试死循环。修复后：整批放弃多段，降级单段完整下载。
  it('服务器忽略 Range 回 200 → 整批放弃多段，降级单段完整下载且产物正确', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    // 记录每个 GET 请求是否带 Range 头，用于断言「最终走了单段全新下载」
    const getRangeHeaders: Array<string | undefined> = []
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = (init?.method as string | undefined) ?? 'GET'
      if (method === 'HEAD') {
        return makeHeadResponse(MULTI_PART_CONTENT.length)
      }
      getRangeHeaders.push((init?.headers as Record<string, string> | undefined)?.Range)
      // 无论是否带 Range，一律回 200 + 全量内容（模拟忽略 Range 的服务器）
      return makeContentResponse(MULTI_PART_CONTENT)
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'rm3-ignore-range.zip',
      downloadUrl: 'https://example.com/rm3-ignore-range.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    // 降级路径可观察信号：多段阶段若干带 Range 的 GET 之后，还有一个无 Range 头
    // 的 GET——那是降级后的单段完整下载（全新下载不发 Range 头）。
    expect(getRangeHeaders.filter((r) => r !== undefined).length).toBeGreaterThanOrEqual(1)
    expect(getRangeHeaders).toContain(undefined)
    expectIntactFile(result.filePath)
    expectNoLeftovers('rm3-ignore-range.zip')
  })

  // RM3-2: 206 但段长与请求不符（代理返回错误区间/截短内容）。
  // 无论 content-length 是否可提前发现，都应降级单段完整下载，绝不合并错位内容。
  it('段响应 206 但段长与请求不符 → 降级单段完整下载', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = (init?.method as string | undefined) ?? 'GET'
      if (method === 'HEAD') {
        return makeHeadResponse(MULTI_PART_CONTENT.length)
      }
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      // 无 Range 头 = 降级后的单段完整下载，回全量
      if (!match) {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      const start = Number(match[1])
      // 回 206 但 body 只有 1KB（远小于段长 3MB），content-length 与实际 body 相符，
      // 触发「content-length != 段长」提前拦截分支
      const wrongSlice = MULTI_PART_CONTENT.subarray(start, start + TRUNCATED_PART_BYTES)
      return new Response(new Uint8Array(wrongSlice), {
        status: 206,
        headers: {
          'Content-Length': String(wrongSlice.length),
          'Content-Range': `bytes ${start}-${start + wrongSlice.length - 1}/${MULTI_PART_CONTENT.length}`,
        },
      })
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'rm3-content-length-mismatch.zip',
      downloadUrl: 'https://example.com/rm3-cl-mismatch.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expectIntactFile(result.filePath)
    expectNoLeftovers('rm3-content-length-mismatch.zip')
  })

  // RM3-3: 206 但 content-length 声称与段长相符、body 实际被截短（chunked 传输或
  // 代理半途截断）。提前拦截无法发现，靠流结束后的实下字节数兜底校验降级。
  it('段响应 206 且 content-length 声称相符但 body 实际截短 → 流结束校验降级单段', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = (init?.method as string | undefined) ?? 'GET'
      if (method === 'HEAD') {
        return makeHeadResponse(MULTI_PART_CONTENT.length)
      }
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      if (!match) {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      const start = Number(match[1])
      const end = Number(match[2])
      // content-length 声称等于段长（与请求一致），但 body 实际只有 1KB——声称与实况不符
      const shortSlice = MULTI_PART_CONTENT.subarray(start, start + TRUNCATED_PART_BYTES)
      return new Response(new Uint8Array(shortSlice), {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${MULTI_PART_CONTENT.length}`,
        },
      })
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'rm3-body-truncated.zip',
      downloadUrl: 'https://example.com/rm3-truncated.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expectIntactFile(result.filePath)
    expectNoLeftovers('rm3-body-truncated.zip')
  })
})

// ════════════════════════════════════════════════════════════════
// 批次 5（u5a）：resume-state 原子写序列（§3.7.2 m12）
// 断言 saveResumeState 走「写 .tmp → renameSync 到终态」序列而非直写。
// ════════════════════════════════════════════════════════════════
describe('批次 5: resume-state 原子写序列（§3.7.2）', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    fsSpy.writeCalls.length = 0
    fsSpy.renameCalls.length = 0
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true })
  })

  it('多段下载过程中 saveResumeState → 先写 resume-state.json.tmp 再 renameSync 到终态（验收③）', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    // 单段大文件下载（服务器不支持 Range）→ data 流式回调触发 saveResumeState
    // （多段成功路径不写 resume-state，分段写入只发生在单段流式下载）
    globalThis.fetch = vi.fn(async (_url, init) => {
      const method = (init?.method as string | undefined) ?? 'GET'
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Length': String(MULTI_PART_CONTENT.length), 'Accept-Ranges': 'none' },
        })
      }
      return makeContentResponse(MULTI_PART_CONTENT)
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'multipart-atomic.zip',
      downloadUrl: 'https://example.com/multipart-atomic.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expect(result.filePath).toMatch(/multipart-atomic\.zip$/)

    // 序列断言：resume-state.json.tmp 的 writeFileSync 先于 renameSync(→resume-state.json)
    const tmpWrite = fsSpy.writeCalls.find((c) => c.path.endsWith('resume-state.json.tmp'))
    const rename = fsSpy.renameCalls.find((c) => c.to.endsWith('resume-state.json'))
    expect(tmpWrite, '应先写 resume-state.json.tmp').toBeDefined()
    expect(rename, '应 renameSync 到 resume-state.json 终态').toBeDefined()
    const writeIdx = fsSpy.writeCalls.indexOf(tmpWrite!)
    const renameIdx = fsSpy.renameCalls.indexOf(rename!)
    expect(rename).toBeDefined()
    expect(rename!.from).toBe(tmpWrite!.path)
    // 下载成功后 clearResumeState 清掉终态文件（且 .tmp 不残留）
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'resume-state.json'))).toBe(false)
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'resume-state.json.tmp'))).toBe(false)
  })
})
