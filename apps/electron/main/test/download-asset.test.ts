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
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
