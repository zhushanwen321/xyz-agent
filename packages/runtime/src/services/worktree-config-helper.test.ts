import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { getAutoRenameEnabled, setAutoRenameEnabled, getAutoRenameEnabledPath } from './worktree-config-helper.js'

describe('auto-rename enabled 标志文件', () => {
  let tmpRoot: string

  beforeEach(() => {
    // 每个测试独立临时目录，避免互相干扰
    tmpRoot = mkdtempSync(join(tmpdir(), 'auto-rename-test-'))
    // getPiAgentDir 经 getDataDir 读 XYZ_AGENT_DATA_DIR → 临时目录/pi/agent
    vi.stubEnv('XYZ_AGENT_DATA_DIR', tmpRoot)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('getAutoRenameEnabledPath 解析到 <XYZ_AGENT_DATA_DIR>/pi/agent/auto-rename-enabled', () => {
    expect(getAutoRenameEnabledPath()).toBe(join(tmpRoot, 'pi', 'agent', 'auto-rename-enabled'))
  })

  it('文件不存在时 getAutoRenameEnabled 返回 false（默认关闭）', () => {
    expect(getAutoRenameEnabled()).toBe(false)
  })

  it('setAutoRenameEnabled(true) 创建文件后 getAutoRenameEnabled 返回 true', () => {
    setAutoRenameEnabled(true)
    expect(existsSync(getAutoRenameEnabledPath())).toBe(true)
    expect(getAutoRenameEnabled()).toBe(true)
  })

  it('setAutoRenameEnabled(false) 删除已存在的文件', () => {
    setAutoRenameEnabled(true)
    expect(getAutoRenameEnabled()).toBe(true)
    setAutoRenameEnabled(false)
    expect(existsSync(getAutoRenameEnabledPath())).toBe(false)
    expect(getAutoRenameEnabled()).toBe(false)
  })

  it('文件不存在时 setAutoRenameEnabled(false) 不报错（吞 ENOENT）', () => {
    expect(() => setAutoRenameEnabled(false)).not.toThrow()
    expect(getAutoRenameEnabled()).toBe(false)
  })
})
