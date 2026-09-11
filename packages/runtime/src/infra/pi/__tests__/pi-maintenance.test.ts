/**
 * pi-maintenance 单元测试（v9 布局对齐 U14b，设计 §6.11）：
 * - warnLegacyPiLayout 残留探测形态判据：`<dataDir>/pi` 含 agent/|sessions/ 子目录 →
 *   WARN + 迁移指引；不含（空壳残片/目录缺席/同名文件占位）→ 静默
 * - getPiGlobalAgentDir 从 getDataDir() 起推导（dataDir 的兄弟 .pi/agent，不再锚定
 *   getPiAgentDir 的 pi/agent 子树层数——SSOT 切 <dataDir>/agent 后向上 3 层会多走一层）
 * - syncBundledResources 导出可用（非打包环境 no-op 不抛错）
 *
 * 写删目标全部 mkdtempSync 自建自删（fs-guard 白名单 = os.tmpdir()），不触碰真实数据目录。
 *
 * 运行命令：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-maintenance.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve as pathResolve } from 'node:path'
import { tmpdir } from 'node:os'
import { getPiGlobalAgentDir, syncBundledResources, warnLegacyPiLayout } from '../pi-maintenance.js'

/** 建临时数据目录并在测试结束后删除（写删目标限 os.tmpdir()，fs-guard 白名单内）。 */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return dir
}

describe('warnLegacyPiLayout 残留探测（形态判据）', () => {
  let root: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = makeTempDir('pi-maintenance-legacy-')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('pi/ 含 agent/ 子目录 → WARN 且含旧布局路径与迁移脚本指引', () => {
    mkdirSync(join(root, 'pi', 'agent'), { recursive: true })
    warnLegacyPiLayout(root)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls.map(String).join(' ')
    expect(msg).toContain(join(root, 'pi'))
    expect(msg).toContain('不可见')
    expect(msg).toContain('migrate-pi-layout-v2.mjs')
  })

  it('pi/ 含 sessions/ 子目录 → WARN', () => {
    mkdirSync(join(root, 'pi', 'sessions'), { recursive: true })
    warnLegacyPiLayout(root)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('pi/ 存在但无 agent|sessions 子目录（空壳残片形态）→ 静默', () => {
    mkdirSync(join(root, 'pi'), { recursive: true })
    writeFileSync(join(root, 'pi', 'auth.json'), '{}')
    warnLegacyPiLayout(root)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('pi/ 不存在（新布局/已迁移）→ 静默', () => {
    warnLegacyPiLayout(root)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('pi/agent 为同名文件而非子目录 → 静默（形态判据非存在性判据）', () => {
    mkdirSync(join(root, 'pi'), { recursive: true })
    writeFileSync(join(root, 'pi', 'agent'), 'not-a-dir')
    warnLegacyPiLayout(root)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('默认参数走 getDataDir()：env 指向的 dataDir 下旧布局 → WARN（生产调用路径）', () => {
    const savedEnv = process.env.XYZ_AGENT_DATA_DIR
    process.env.XYZ_AGENT_DATA_DIR = root
    try {
      mkdirSync(join(root, 'pi', 'sessions'), { recursive: true })
      warnLegacyPiLayout()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      if (savedEnv === undefined) delete process.env.XYZ_AGENT_DATA_DIR
      else process.env.XYZ_AGENT_DATA_DIR = savedEnv
    }
  })
})

describe('getPiGlobalAgentDir 推导（从 getDataDir() 起）', () => {
  const savedEnv = process.env.XYZ_AGENT_DATA_DIR

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.XYZ_AGENT_DATA_DIR
    else process.env.XYZ_AGENT_DATA_DIR = savedEnv
  })

  it('= <dataDir> 兄弟 .pi/agent（向上 1 层，不随 getPiAgentDir 内部层数漂移）', () => {
    const dataDir = makeTempDir('pi-maintenance-data-')
    process.env.XYZ_AGENT_DATA_DIR = dataDir
    try {
      expect(getPiGlobalAgentDir()).toBe(pathResolve(dataDir, '..', '.pi', 'agent'))
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('推导与 dataDir 嵌套深度无关（tmp 深层 dataDir 仍得兄弟 .pi/agent）', () => {
    const outer = makeTempDir('pi-maintenance-outer-')
    const dataDir = join(outer, 'deep', 'nested', 'xyz-agent-data')
    mkdirSync(dataDir, { recursive: true })
    process.env.XYZ_AGENT_DATA_DIR = dataDir
    try {
      expect(getPiGlobalAgentDir()).toBe(pathResolve(dataDir, '..', '.pi', 'agent'))
    } finally {
      rmSync(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('syncBundledResources 导出可用', () => {
  const savedFlag = process.env.XYZ_AGENT_PACKAGED

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.XYZ_AGENT_PACKAGED
    else process.env.XYZ_AGENT_PACKAGED = savedFlag
  })

  it('函数已导出可调用；非打包环境（未设 XYZ_AGENT_PACKAGED）no-op 不抛错', () => {
    expect(typeof syncBundledResources).toBe('function')
    delete process.env.XYZ_AGENT_PACKAGED
    expect(() => syncBundledResources()).not.toThrow()
  })
})
