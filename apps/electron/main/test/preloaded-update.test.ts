/**
 * 预下载产物元信息 SSOT（preloaded-update）单元测试。
 *
 * 覆盖 preloaded-update.ts 全部导出：
 *   1. writePreloadedUpdate + readPreloadedUpdate 往返（同版本同 platform asset → 返回 filePath）
 *   2. version 不匹配 → readPreloadedUpdate 返回 null + 清除
 *   3. 产物文件不存在 → readPreloadedUpdate 返回 null + 清除
 *
 * Mock 策略参考 orchestrator.test.ts：
 *   - 用真实 fs（临时目录），经 XYZ_AGENT_DATA_DIR 重定向 PRELOADED_UPDATE_FILE
 *     （必须在 import constants 前设，constants.ts 顶层读 getDataDir）
 *   - process.platform 经 Object.defineProperty 桩为 'darwin'（readPreloadedUpdate 依赖
 *     process.platform 选平台 asset name），beforeEach 设、afterEach 还原
 *   - release 带 macArm64Zip asset，对应 darwin 平台
 *   - env + platform 就绪后动态 import 拿独立模块实例
 *
 * 运行：cd apps/electron/main && npx vitest run test/preloaded-update.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  closeSync,
  openSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LatestReleaseInfo } from '@xyz-agent/shared'

// ── 必须在 import constants（间接被 preloaded-update import）前设 ──────
// constants.ts 顶层计算 PRELOADED_UPDATE_FILE = path.join(getDataDir(), 'update', ...),
// getDataDir 读 XYZ_AGENT_DATA_DIR。赋值放最前，下方模块经动态 import 在 env 就绪后加载。
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'preloaded-update-'))
process.env.XYZ_AGENT_DATA_DIR = TMP_DATA_DIR

interface PreloadedUpdateModule {
  writePreloadedUpdate: (release: LatestReleaseInfo, filePath: string) => void
  readPreloadedUpdate: (release: LatestReleaseInfo) => string | null
  clearPreloadedUpdate: () => void
}

// 动态 import：确保 env 赋值先生效
async function loadModule(): Promise<PreloadedUpdateModule> {
  return await import('../update/preloaded-update.js')
}

/** preloaded-update.json 落盘路径（与 constants.ts 推导一致） */
const PRELOADED_UPDATE_FILE = path.join(TMP_DATA_DIR, 'update', 'preloaded-update.json')

/**
 * LatestReleaseInfo fixture（mac + deb 都覆盖，darwin 平台用 macArm64Zip）。
 * 参考 orchestrator.test.ts 的 MAC_RELEASE。
 */
function makeRelease(version = '0.9.0'): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: '## What changed\n- preloaded-update fixture',
    publishedAt: '2025-12-01T00:00:00Z',
    htmlUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/tag/v0.9.0',
    assets: {
      macArm64Zip: {
        name: 'xyz-agent-mac-arm64.zip',
        downloadUrl: 'https://example.com/mac.zip',
        size: 1000,
        sha256: 'a'.repeat(64),
      },
    },
  }
}

describe('preloaded-update (预下载产物元信息 SSOT)', () => {
  let mod: PreloadedUpdateModule
  let originalPlatform: PropertyDescriptor | undefined
  // 记录本用例创建的临时产物文件，afterEach 清理
  const createdFiles: string[] = []

  beforeEach(async () => {
    // 桩 platform 为 darwin（readPreloadedUpdate 内 getAssetName 读 process.platform）
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    mod = await loadModule()
    // 每个用例独立：清掉残留的 preloaded-update.json
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    createdFiles.length = 0
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    // 清理本用例创建的产物文件
    for (const f of createdFiles) {
      if (existsSync(f)) rmSync(f, { force: true })
    }
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  /** 创建一个真实存在的临时产物文件，返回绝对路径 */
  function createProductFile(name: string): string {
    const filePath = path.join(TMP_DATA_DIR, 'products', name)
    mkdirSync(path.dirname(filePath), { recursive: true })
    // 创建空文件（existsSync 判定为 true 即可）
    const fd = openSync(filePath, 'w')
    closeSync(fd)
    createdFiles.push(filePath)
    return filePath
  }

  // ── 1. writePreloadedUpdate + readPreloadedUpdate 往返 ──────────
  it('writePreloadedUpdate 后 readPreloadedUpdate 返回同一 filePath（同版本同 platform asset）', () => {
    const release = makeRelease('0.9.0')
    const filePath = createProductFile('mac.zip')

    mod.writePreloadedUpdate(release, filePath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)

    // 同版本 + 同平台 asset + 文件存在 → 返回 filePath
    const result = mod.readPreloadedUpdate(release)
    expect(result).toBe(filePath)
    // 读取有效不清除
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)
  })

  // ── 2. version 不匹配 → 返回 null + 清除 ───────────────────────
  it('readPreloadedUpdate：release.version 不匹配 → 返回 null + 清除元信息', () => {
    const writeRelease = makeRelease('0.9.0')
    const filePath = createProductFile('mac.zip')
    mod.writePreloadedUpdate(writeRelease, filePath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)

    // 读取时 release 版本变了（0.9.1）→ 产物失效
    const readRelease = makeRelease('0.9.1')
    const result = mod.readPreloadedUpdate(readRelease)
    expect(result).toBeNull()
    // 元信息被清除
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
  })

  // ── 3. 产物文件不存在 → 返回 null + 清除 ───────────────────────
  it('readPreloadedUpdate：产物文件已被删除 → 返回 null + 清除元信息', () => {
    const release = makeRelease('0.9.0')
    // 写入一个指向不存在文件的元信息
    const ghostPath = path.join(TMP_DATA_DIR, 'products', 'ghost.zip')
    expect(existsSync(ghostPath)).toBe(false)
    mod.writePreloadedUpdate(release, ghostPath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)

    const result = mod.readPreloadedUpdate(release)
    expect(result).toBeNull()
    // 元信息被清除
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
  })

  // ── 额外：readPreloadedUpdate 文件不存在 → 返回 null ────────────
  it('readPreloadedUpdate：元信息文件不存在 → 返回 null（不抛错）', () => {
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
    const result = mod.readPreloadedUpdate(makeRelease('0.9.0'))
    expect(result).toBeNull()
  })

  // ── 额外：clearPreloadedUpdate 显式清除 ────────────────────────
  it('clearPreloadedUpdate：显式清除已存在的元信息文件', () => {
    const filePath = createProductFile('mac.zip')
    mod.writePreloadedUpdate(makeRelease('0.9.0'), filePath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)
    mod.clearPreloadedUpdate()
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
    // 幂等：再次清除不抛错
    expect(() => mod.clearPreloadedUpdate()).not.toThrow()
  })

  // ── 额外：落盘结构含 version/assetName/filePath/downloadedAt ────
  it('writePreloadedUpdate：落盘 JSON 含 version/assetName/filePath/downloadedAt', () => {
    const release = makeRelease('0.9.0')
    const filePath = createProductFile('mac.zip')
    mod.writePreloadedUpdate(release, filePath)

    // 解析落盘文件验证结构（unknown + 字段访问，不用 as any）
    const raw = readFileSync(PRELOADED_UPDATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const obj = parsed as Record<string, unknown>
    expect(obj.version).toBe('0.9.0')
    // assetName 与 darwin 平台 mac asset name 一致
    expect(obj.assetName).toBe('xyz-agent-mac-arm64.zip')
    expect(obj.filePath).toBe(filePath)
    expect(typeof obj.downloadedAt).toBe('string')
  })
})
