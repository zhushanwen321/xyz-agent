/**
 * ProcessManager.findPiExecutable 单测（wave3 P0：pi 路径配置化）。
 *
 * 覆盖场景：
 * - TC1: XYZ_PI_BIN 指向真实文件 → 直接返回（最高优先级）
 * - TC2: XYZ_PI_BIN 指向不存在路径 → warn + 继续兜底链
 * - TC3: XYZ_PI_BIN 未设、非 packaged、dev resources 缺、<dataDir>/pi/<binary> 命中
 * - TC4: XYZ_AGENT_PACKAGED=1 + process.cwd()/pi/<binary> 命中（packaged 零回归）
 * - TC6: 所有 env 不设 + 所有 existsSync false → 兜底返回 'pi'
 *
 * mock 策略：
 * - node:child_process 默认全 throw（PATH which / nvm 扫描全 miss，避免污染真实环境）
 * - node:fs 用真实 fs（mkdtempSync 建临时目录放 mock pi binary，existsSync 真实判定）
 * - process.env 在 beforeEach 存原始值、afterEach 恢复
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

// 全部 child_process 调用默认 throw，让 PATH which 兜底 miss。
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => { throw new Error('mocked: not found') }),
  execFileSync: vi.fn(() => { throw new Error('mocked: not found') }),
}))

// nvm 扫描用 readdirSync；开发者机器常装了 pi（nvm 路径命中），会让兜底链不落到 'pi'。
// 默认让 readdirSync throw，nvm 分支 catch 后跳过 → 行为可预测、不耦合宿主环境。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: vi.fn(() => { throw new Error('mocked: dir not found') }),
  }
})

const mockedExecSync = vi.mocked(execSync)
const mockedReaddirSync = vi.mocked(readdirSync)

// findPiExecutable 基于 process.platform / process.arch 推导 binaryName，测试沿用真实值。
function expectedBinaryName(): string {
  const platform = process.platform
  const arch = process.arch
  return platform === 'win32' ? `pi-windows-${arch}.exe` : `pi-${platform}-${arch}`
}

describe('findPiExecutable', () => {
  const originalEnv = { ...process.env }
  const originalCwd = process.cwd()
  let tmpRoot: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execSync).mockImplementation(() => { throw new Error('mocked: not found') })
    mockedExecSync.mockImplementation(() => { throw new Error('mocked: not found') })
    // readdirSync 默认 throw：nvm 扫描分支 catch 后跳过，不耦合宿主是否装 pi
    mockedReaddirSync.mockImplementation(() => { throw new Error('mocked: dir not found') })

    tmpRoot = mkdtempSync(join(tmpdir(), 'pi-pm-test-'))

    // 清理可能影响判定的环境变量，确保每个 TC 从干净基线开始。
    delete process.env.XYZ_PI_BIN
    delete process.env.XYZ_AGENT_PACKAGED
    // XYZ_AGENT_DATA_DIR 默认指向 tmpRoot（让 <dataDir>/pi/<binary> 槽位可控）
    process.env.XYZ_AGENT_DATA_DIR = tmpRoot
  })

  afterEach(() => {
    // 恢复 env / cwd，清理临时目录。
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v
    }
    try { process.chdir(originalCwd) } catch { /* ignore */ }
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('TC1: XYZ_PI_BIN 指向真实文件时直接返回', async () => {
    const { findPiExecutable } = await import('../src/infra/pi/process-manager.js')
    const customPi = join(tmpRoot, 'custom-pi')
    writeFileSync(customPi, '#!/bin/sh\n', 'utf-8')
    process.env.XYZ_PI_BIN = customPi

    const result = findPiExecutable(tmpRoot)

    expect(result).toBe(customPi)
  })

  it('TC2: XYZ_PI_BIN 指向不存在路径时 warn 并继续兜底，最终返回 pi', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { findPiExecutable } = await import('../src/infra/pi/process-manager.js')
    process.env.XYZ_PI_BIN = join(tmpRoot, 'nonexistent-pi')

    const result = findPiExecutable(tmpRoot)

    expect(result).toBe('pi')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('XYZ_PI_BIN points to non-existent'),
    )
    warnSpy.mockRestore()
  })

  it('TC3: dataDir/pi/<binary> 命中时返回该路径（XYZ_PI_BIN 未设）', async () => {
    const { findPiExecutable } = await import('../src/infra/pi/process-manager.js')
    // dataDir slot：<tmpRoot>/pi/<binaryName>
    const dataDirPi = join(tmpRoot, 'pi', expectedBinaryName())
    mkdirSync(join(tmpRoot, 'pi'), { recursive: true })
    writeFileSync(dataDirPi, '#!/bin/sh\n', 'utf-8')
    // dev resources 故意不建（让 dev 分支 miss 落到 dataDir 槽位）
    const devResources = join(tmpRoot, 'resources', 'pi', expectedBinaryName())
    expect(devResources).not.toBe(dataDirPi)

    const result = findPiExecutable(tmpRoot)

    expect(result).toBe(dataDirPi)
    // 验证优先于 PATH：execSync 全 throw 不应被调用返回值（已被 mock throw）
    expect(mockedExecSync).not.toHaveReturned()
  })

  it('TC4: packaged 模式下 process.cwd()/pi/<binary> 命中（零回归）', async () => {
    const { findPiExecutable } = await import('../src/infra/pi/process-manager.js')
    process.env.XYZ_AGENT_PACKAGED = '1'
    // chdir 到 tmpRoot，使 process.cwd() 可控
    process.chdir(tmpRoot)
    // 造 <cwd>/pi/<binaryName>（cwd 经 chdir 后可能含 symlink 解析，用 process.cwd() 构造预期值）
    const cwdAfterChdir = process.cwd()
    const bundledPi = join(cwdAfterChdir, 'pi', expectedBinaryName())
    mkdirSync(join(cwdAfterChdir, 'pi'), { recursive: true })
    writeFileSync(bundledPi, '#!/bin/sh\n', 'utf-8')

    const result = findPiExecutable(tmpRoot)

    expect(result).toBe(bundledPi)
  })

  it('TC6: 所有 env 不设、所有 fallback miss 时返回 pi', async () => {
    const { findPiExecutable } = await import('../src/infra/pi/process-manager.js')
    // 不建任何 pi binary；child_process execSync 已 mock 全 throw（PATH which miss）；
    // readdirSync 已 mock 全 throw（nvm miss）；common locations 在 CI/干净机器上无 pi。
    const result = findPiExecutable(tmpRoot)

    expect(result).toBe('pi')
  })
})
