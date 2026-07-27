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
