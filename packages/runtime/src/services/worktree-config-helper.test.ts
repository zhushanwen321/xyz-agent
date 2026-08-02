import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { getAutoRenameEnabled, setAutoRenameEnabled, getAutoRenameEnabledPath, ensureAutoRenameDefault } from './worktree-config-helper.js'

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

describe('ensureAutoRenameDefault', () => {
  let tmpRoot: string
  const initializedPath = () => join(tmpRoot, 'pi', 'agent', 'auto-rename-initialized')

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'auto-rename-init-'))
    vi.stubEnv('XYZ_AGENT_DATA_DIR', tmpRoot)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('首次调用：创建 initialized 标记 + 开启 auto-rename', () => {
    expect(existsSync(initializedPath())).toBe(false)
    expect(getAutoRenameEnabled()).toBe(false)

    ensureAutoRenameDefault()

    // initialized 标记已写
    expect(existsSync(initializedPath())).toBe(true)
    // 默认开启 auto-rename
    expect(getAutoRenameEnabled()).toBe(true)
  })

  it('幂等性：initialized 标记存在时不干预，不覆盖用户的关闭操作', () => {
    // 模拟用户已关闭 auto-rename（initialized 标记存在，但 enabled 文件不存在）
    setAutoRenameEnabled(false)
    // 手动创建 initialized 标记（表示已完成首次初始化）
    // 先建好 pi/agent 目录再写标记（ensureAutoRenameDefault 检测到标记存在会直接 return，
    // 不会自己 mkdir，所以测试要预先把目录和标记造好）
    const { writeFileSync, mkdirSync } = require('node:fs')
    const { dirname } = require('node:path')
    mkdirSync(dirname(initializedPath()), { recursive: true })
    writeFileSync(initializedPath(), '', 'utf-8')

    ensureAutoRenameDefault()

    // 用户关闭的状态被保留，没有被 boot 反复重开
    expect(getAutoRenameEnabled()).toBe(false)
    // initialized 标记仍在
    expect(existsSync(initializedPath())).toBe(true)
  })

  it('初始化失败不抛错（不阻塞 boot）', () => {
    // 让 getPiAgentDir 抛错：把 XYZ_AGENT_DATA_DIR 指向一个不存在的根，使 mkdirSync 失败
    // （mock 一个不可创建的路径：指向一个已被删除的目录的子路径）
    const { mkdirSync } = require('node:fs')
    const origMkdir = mkdirSync
    require('node:fs').mkdirSync = vi.fn(() => { throw new Error('mock mkdir failure') })

    expect(() => ensureAutoRenameDefault()).not.toThrow()

    // 恢复
    require('node:fs').mkdirSync = origMkdir
  })
})
