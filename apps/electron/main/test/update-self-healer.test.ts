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
