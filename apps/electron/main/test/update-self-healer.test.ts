/**
 * W3 TDD 测试：update-self-healer（启动自愈器）。
 *
 * 覆盖场景 W3TC11：
 *   W3TC11a status='replacing' + .old 存在 → 触发回滚 + 写 status='rolled-back'，返回 true
 *   W3TC11a-noop status='replacing' + .old 不存在（下载期失败）→ 写 status='no-op'，返回 false
 *   W3TC11b status='done' → no-op 返回 false（不回滚）
 *   W3TC11c update-result.json 不存在 → no-op 返回 false
 *   W3TC11d result 文件损坏（JSON 解析失败）→ 不抛，返回 false
 *
 * Mock 策略：用真实 fs（tmp 目录）写 update-result.json，self-healer 读 + 回滚。
 *   - mac 回滚路径：用真实 tmp 目录模拟 .app bundle + .old 备份
 *
 * 运行：cd apps/electron/main && npx vitest run test/update-self-healer.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── electron mock：cleanupCompletedUpdate 调 app.getVersion()，需桩为可控版本 ──
// vi.hoisted 保证 vi.mock 工厂能引用（vitest 会把 vi.mock 提升到文件顶部）。
const electronMock = vi.hoisted(() => ({ appVersion: '0.8.49' }))
vi.mock('electron', () => ({
  app: {
    getVersion: () => electronMock.appVersion,
  },
}))

// ── 必须在 import constants（间接被 self-healer import）前设 ────────
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'w3-healer-'))
process.env.XYZ_AGENT_DATA_DIR = TMP_DATA_DIR

// 动态 import：env 已设
async function loadModule() {
  return await import('../update/update-self-healer.js')
}

describe('W3: update-self-healer (W3TC11)', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let originalExecPath: string
  const updateDir = path.join(TMP_DATA_DIR, 'update')
  const resultFile = path.join(updateDir, 'update-result.json')

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    originalExecPath = process.execPath
    vi.clearAllMocks()
    mkdirSync(updateDir, { recursive: true })
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true })
    vi.restoreAllMocks()
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true })
  })

  /** 写 update-result.json */
  function writeResult(data: Record<string, unknown>): void {
    writeFileSync(resultFile, JSON.stringify(data))
  }

  // ── W3TC11c：result 文件不存在 → no-op ─────────────────────────
  it('W3TC11c: update-result.json 不存在 → 返回 false（no-op）', async () => {
    rmSync(resultFile, { force: true })
    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()
    expect(result).toBe(false)
  })

  // ── W3TC11b：status='done' → no-op ─────────────────────────────
  it('W3TC11b: status=done → 返回 false（终态不回滚）', async () => {
    writeResult({ status: 'done', version: '0.9.0', at: '2025-12-01T00:00:00Z' })
    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()
    expect(result).toBe(false)
    // result 文件未被改写（仍为 done）
    expect(JSON.parse(existsSync(resultFile) ? readFileSync(resultFile, 'utf-8') : '{}').status).toBe('done')
  })

  it('W3TC11b2: status=failed → 返回 false（终态不回滚）', async () => {
    writeResult({ status: 'failed', version: '0.9.0', at: '2025-12-01T00:00:00Z', error: 'sha mismatch' })
    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()
    expect(result).toBe(false)
  })

  // ── W3TC11a：status='replacing' + .old 不存在 → no-op ───────────
  // 语义：下载/校验阶段失败（download-asset 在替换前就失败，没产生 .old），
  //       原 app 未被改动 → 无需回滚，写 status='no-op' 返回 false。
  it('W3TC11a: status=replacing + .old 不存在（linux 无 APPIMAGE）→ 写 no-op，返回 false', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    delete process.env.APPIMAGE // 无 APPIMAGE → getOldBackupPath() 返回 undefined
    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(false)
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('no-op')
  })

  // ── W3TC11a-linux-old：status=replacing + linux .old 存在 → 回滚 AppImage ─
  it('W3TC11a-linux-old: linux + APPIMAGE 设定 + .old 存在 → rm 半截 + mv .old 回来', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    // 用 tmp 目录模拟 AppImage（半截态）+ .old（备份）
    const tmpAppDir = mkdtempSync(path.join(tmpdir(), 'w3-linux-app-'))
    const appImage = path.join(tmpAppDir, 'xyz-agent-x86_64.AppImage')
    const oldImage = `${appImage}.old`
    writeFileSync(appImage, 'half-installed')
    writeFileSync(oldImage, 'old-good-version')

    process.env.APPIMAGE = appImage
    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(true)
    // .old 已 mv 回 AppImage（半截态被 rm + .old 恢复）
    expect(existsSync(appImage)).toBe(true)
    expect(existsSync(oldImage)).toBe(false)
    expect(readFileSync(appImage, 'utf-8')).toBe('old-good-version')
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('rolled-back')

    rmSync(tmpAppDir, { recursive: true, force: true })
  })

  // ── W3TC11a-linux-noop：status=replacing + linux APPIMAGE 设定但无 .old → no-op
  it('W3TC11a-linux-noop: linux + APPIMAGE 设定 + 无 .old → 写 no-op 返回 false', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    // APPIMAGE 指向一个不存在的路径（仅环境变量，不创建文件）
    const tmpAppDir = mkdtempSync(path.join(tmpdir(), 'w3-linux-noop-'))
    const appImage = path.join(tmpAppDir, 'xyz-agent.AppImage')
    process.env.APPIMAGE = appImage
    // 不创建 appImage / appImage.old → getOldBackupPath() 返回的 .old 不存在 → no-op

    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(false)
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('no-op')

    rmSync(tmpAppDir, { recursive: true, force: true })
  })

  // ── W3TC11a-mac：mac 平台 status=replacing + .old 存在 → 回滚 .app ─
  it('W3TC11a-mac: mac 平台 status=replacing + .old 备份存在 → rm 半截 + mv .old 回来', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    // 模拟 .app 目录结构（用 tmp 目录）：execPath = <tmpApp>/Contents/MacOS/xyz-agent
    const tmpAppRoot = mkdtempSync(path.join(tmpdir(), 'w3-mac-app-'))
    const appBundle = path.join(tmpAppRoot, 'xyz-agent.app')
    const oldBundle = `${appBundle}.old`
    // 创建假 .app（半截态）+ .old（备份）
    mkdirSync(path.join(appBundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(appBundle, 'Contents', 'MacOS', 'xyz-agent'), 'half-installed')
    mkdirSync(path.join(oldBundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(oldBundle, 'Contents', 'MacOS', 'xyz-agent'), 'old-good-version')
    // execPath 桩：<appBundle>/Contents/MacOS/xyz-agent
    Object.defineProperty(process, 'execPath', {
      value: path.join(appBundle, 'Contents', 'MacOS', 'xyz-agent'),
      configurable: true,
    })

    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(true)
    // .old 已 mv 回 .app（半截态被 rm + .old 恢复）
    expect(existsSync(appBundle)).toBe(true)
    expect(existsSync(oldBundle)).toBe(false)
    // .app 内容是 .old 的内容（old-good-version）
    expect(readFileSync(path.join(appBundle, 'Contents', 'MacOS', 'xyz-agent'), 'utf-8')).toBe('old-good-version')
    // result 已写 rolled-back
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('rolled-back')

    // 清理
    rmSync(tmpAppRoot, { recursive: true, force: true })
  })

  // ── W3TC11a-mac-noop：mac 平台 status=replacing + 无 .old → no-op ─
  it('W3TC11a-mac-noop: mac 平台 status=replacing + 无 .old 备份 → 写 no-op 返回 false', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    // 模拟 .app 目录但无 .old（中断发生在下载期，未进入替换阶段）
    const tmpAppRoot = mkdtempSync(path.join(tmpdir(), 'w3-mac-noop-'))
    const appBundle = path.join(tmpAppRoot, 'xyz-agent.app')
    mkdirSync(path.join(appBundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(appBundle, 'Contents', 'MacOS', 'xyz-agent'), 'untouched-original')
    Object.defineProperty(process, 'execPath', {
      value: path.join(appBundle, 'Contents', 'MacOS', 'xyz-agent'),
      configurable: true,
    })

    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(false)
    // 原 .app 未被改动（rm + mv .old 不会触发）
    expect(readFileSync(path.join(appBundle, 'Contents', 'MacOS', 'xyz-agent'), 'utf-8')).toBe('untouched-original')
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('no-op')

    rmSync(tmpAppRoot, { recursive: true, force: true })
  })

  // ── W3TC11d：result 文件损坏 → 不抛，返回 false ────────────────
  it('W3TC11d: result 文件非法 JSON → 不抛，返回 false（不阻塞启动）', async () => {
    writeFileSync(resultFile, 'not-json{broken')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()
    expect(result).toBe(false)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ── cleanupCompletedUpdate：启动时清理已完成/失败的升级产物 ──────
// 覆盖终态清理矩阵（done 真假 / failed / rolled-back / no-op / 无 result / 幂等 / 路径注入）。
describe('cleanupCompletedUpdate', () => {
  const updateDir = path.join(TMP_DATA_DIR, 'update')
  const resultFile = path.join(updateDir, 'update-result.json')
  const preloadedFile = path.join(updateDir, 'preloaded-update.json')
  const pendingFile = path.join(updateDir, 'pending-update.json')
  const updaterScript = path.join(updateDir, 'updater.sh')
  const linuxUpdaterScript = path.join(updateDir, 'updater-linux.sh')
  const updaterLog = path.join(updateDir, 'updater.log')
  const linuxUpdaterLog = path.join(updateDir, 'updater-linux.log')
  const zipFile = path.join(updateDir, 'xyz-agent-mac-arm64.zip')

  beforeEach(() => {
    // 默认 app 版本 = 0.8.49（done 用例默认真 done：current >= target）
    electronMock.appVersion = '0.8.49'
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true })
    mkdirSync(updateDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true })
  })

  /** 写 update-result.json */
  function writeResult(data: Record<string, unknown>): void {
    writeFileSync(resultFile, JSON.stringify(data))
  }

  /**
   * 写入全套升级产物。
   * - preloadedFilePath：preloaded.filePath 指向的下载 zip（默认 updateDir 内的 zipFile）
   * - createZip：是否在 zipFile 处创建实体文件（路径注入用例传 false，用 outside 文件代替）
   */
  function seedArtifacts(opts: { preloadedFilePath?: string; createZip?: boolean } = {}): void {
    const fp = opts.preloadedFilePath ?? zipFile
    if (opts.createZip !== false) writeFileSync(zipFile, 'fake-zip-content')
    writeFileSync(preloadedFile, JSON.stringify({
      version: '0.8.49',
      assetName: 'xyz-agent-mac-arm64.zip',
      filePath: fp,
      downloadedAt: '2025-12-01T00:00:00Z',
      size: 'fake-zip-content'.length,
      release: { version: '0.8.49' },
    }))
    writeFileSync(pendingFile, '{}')
    writeFileSync(updaterScript, '#!/bin/bash')
    writeFileSync(linuxUpdaterScript, '#!/bin/bash')
    writeFileSync(updaterLog, 'log')
    writeFileSync(linuxUpdaterLog, 'log')
  }

  /** 断言全套产物（含 result 自身）已被清理 */
  function expectAllCleaned(extra: string[] = []): void {
    expect(existsSync(resultFile)).toBe(false)
    expect(existsSync(preloadedFile)).toBe(false)
    expect(existsSync(zipFile)).toBe(false)
    expect(existsSync(pendingFile)).toBe(false)
    expect(existsSync(updaterScript)).toBe(false)
    expect(existsSync(linuxUpdaterScript)).toBe(false)
    expect(existsSync(updaterLog)).toBe(false)
    expect(existsSync(linuxUpdaterLog)).toBe(false)
    for (const f of extra) expect(existsSync(f)).toBe(false)
  }

  it('1. done + version <= current（真 done）→ 清全部产物含 result 自身', async () => {
    seedArtifacts()
    writeResult({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    await cleanupCompletedUpdate()
    expectAllCleaned()
  })

  it('2. done + version > current（假 done，app 仍旧版）→ 不清', async () => {
    electronMock.appVersion = '0.8.48' // app 仍旧版，target 0.8.49 未生效
    seedArtifacts()
    writeResult({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    await cleanupCompletedUpdate()
    // 全部产物仍在（未清理）
    expect(existsSync(resultFile)).toBe(true)
    expect(existsSync(preloadedFile)).toBe(true)
    expect(existsSync(zipFile)).toBe(true)
    expect(existsSync(pendingFile)).toBe(true)
  })

  it('3. failed → 清全部含 result', async () => {
    seedArtifacts()
    writeResult({ status: 'failed', version: '0.9.0', at: '2025-12-01T00:00:00Z', error: 'sha mismatch' })
    const { cleanupCompletedUpdate } = await loadModule()
    await cleanupCompletedUpdate()
    expectAllCleaned()
  })

  it('4. rolled-back → 清全部含 result', async () => {
    seedArtifacts()
    writeResult({ status: 'rolled-back', version: '0.9.0', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    await cleanupCompletedUpdate()
    expectAllCleaned()
  })

  it('5. no-op → 清全部含 result + 清 .downloading 残留', async () => {
    seedArtifacts()
    const downloading1 = path.join(updateDir, 'asset.zip.downloading')
    const downloading2 = path.join(updateDir, 'other.downloading')
    writeFileSync(downloading1, 'partial')
    writeFileSync(downloading2, 'partial')
    writeResult({ status: 'no-op', version: '0.9.0', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    await cleanupCompletedUpdate()
    expectAllCleaned([downloading1, downloading2])
  })

  it('6. 无 update-result.json → no-op 不抛错（也不误删现存产物）', async () => {
    // 不写 result，但写一些产物（验证无 result 时不触发清理）
    writeFileSync(pendingFile, '{}')
    writeFileSync(updaterLog, 'log')
    const { cleanupCompletedUpdate } = await loadModule()
    await expect(cleanupCompletedUpdate()).resolves.toBeUndefined()
    // 无 result → 不清理，产物仍在
    expect(existsSync(pendingFile)).toBe(true)
    expect(existsSync(updaterLog)).toBe(true)
  })

  it('7. 幂等：连续两次调用不抛错', async () => {
    seedArtifacts()
    writeResult({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    await cleanupCompletedUpdate()
    // 第二次（产物已无，ignoreENOENT 吞 ENOENT）不抛错
    await expect(cleanupCompletedUpdate()).resolves.toBeUndefined()
    expectAllCleaned()
  })

  it('8. filePath 路径注入（preloaded.filePath 在 UPDATE_DIR 外）→ outside 文件不删、其余产物仍清', async () => {
    // outside 文件放在 OS tmpdir（明确在 UPDATE_DIR 之外）
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'outside-inject-'))
    const outsideFile = path.join(outsideDir, 'outside.txt')
    writeFileSync(outsideFile, 'should-not-delete')
    // createZip=false：本次 preloaded.filePath 指向 outside，updateDir 内无真实 zip
    seedArtifacts({ preloadedFilePath: outsideFile, createZip: false })
    writeResult({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { cleanupCompletedUpdate } = await loadModule()
    await cleanupCompletedUpdate()
    // 路径注入防护：outside 文件未被删
    expect(existsSync(outsideFile)).toBe(true)
    // warn 记录了跳过
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/skip download zip outside UPDATE_DIR/),
    )
    warnSpy.mockRestore()
    // 其余产物仍清
    expect(existsSync(resultFile)).toBe(false)
    expect(existsSync(preloadedFile)).toBe(false)
    expect(existsSync(pendingFile)).toBe(false)
    expect(existsSync(updaterScript)).toBe(false)

    rmSync(outsideDir, { recursive: true, force: true })
  })
})
