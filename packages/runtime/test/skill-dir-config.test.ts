/**
 * skill-dir-config 单测。
 *
 * 核心：buildDirConfigs 把 preset 候选 + discovery 启用列表组合成 UI 用的 SkillDirConfig[]。
 * 重点验证 ADR §5 脏数据过滤——不存在的启用路径（如 /path/a 等 pi 首次写入的占位符）不展示。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import {
  buildDirConfigs,
  PRESET_SKILL_DIRS,
  PRESET_AGENT_DIRS,
} from '../src/services/skill-dir-config.js'
import {
  setSkillDirs,
  getSkillDirs,
  setDiscoveryPath,
} from '../src/infra/pi/discovery-store.js'

describe('skill-dir-config buildDirConfigs', () => {
  let tmpRealDir: string

  beforeEach(() => {
    // 创建真实存在的临时目录（验证 existsSync 过滤逻辑）
    tmpRealDir = mkdtempSync(join(tmpdir(), 'skill-dircfg-'))
  })

  afterEach(() => {
    rmSync(tmpRealDir, { recursive: true, force: true })
  })

  it('过滤不存在的绝对路径脏数据（/path/a 等 pi 占位符）', () => {
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, ['/path/a', '/path/b'])
    const enabled = configs.filter(c => c.enabled)
    // /path/a /path/b 不存在 → 全过滤，只剩 preset 候选
    expect(enabled).toHaveLength(0)
    expect(configs.every(c => c.enabled === false)).toBe(true)
  })

  it('保留存在的绝对路径，过滤不存在的', () => {
    const configs = buildDirConfigs([], [tmpRealDir, '/path/a'])
    const enabledPaths = configs.filter(c => c.enabled).map(c => c.path)
    // 临时目录存在 → 保留；/path/a 不存在 → 过滤
    expect(enabledPaths).toContain(tmpRealDir)
    expect(enabledPaths).not.toContain('/path/a')
  })

  it('~ 路径展开后存在则保留为 enabled（确定性，不依赖测试机环境）', () => {
    const tmpHomeSubdir = mkdtempSync(join(homedir(), '.skill-test-'))
    try {
      const tildePath = '~/' + basename(tmpHomeSubdir)
      const configs = buildDirConfigs([], [tildePath, '/path/a'])
      const enabled = configs.filter(c => c.enabled)
      expect(enabled.map(c => c.path)).toContain(tildePath)
      expect(enabled.map(c => c.path)).not.toContain('/path/a')
    } finally {
      rmSync(tmpHomeSubdir, { recursive: true, force: true })
    }
  })

  it('相对路径不检查存在性（preset 候选语义，buildDirConfigs 不知 cwd）', () => {
    const configs = buildDirConfigs([], ['.agents/skills', '.xyz-agent/skills'])
    const enabledPaths = configs.filter(c => c.enabled).map(c => c.path)
    // 相对路径不做 existsSync 检查，保留为启用
    expect(enabledPaths).toEqual(['.agents/skills', '.xyz-agent/skills'])
  })

  it('preset 未启用的追加为候选（enabled=false），顺序按 preset 固定', () => {
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, [])
    // discovery 空 → 全是 preset 候选，全 disabled
    expect(configs).toHaveLength(PRESET_SKILL_DIRS.length)
    expect(configs.every(c => c.enabled === false)).toBe(true)
    expect(configs.map(c => c.path)).toEqual(PRESET_SKILL_DIRS)
  })

  it('discovery 启用顺序保留（= 用户拖拽优先级，靠前覆盖靠后）', () => {
    // 两个真实存在的目录，验证顺序保留
    const dirA = mkdtempSync(join(tmpdir(), 'skill-order-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'skill-order-b-'))
    try {
      const configs = buildDirConfigs([], [dirB, dirA])
      const enabled = configs.filter(c => c.enabled)
      // 顺序与传入一致（dirB 在前）
      expect(enabled.map(c => c.path)).toEqual([dirB, dirA])
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('agent preset 结构对称（PRESET_AGENT_DIRS）', () => {
    const configs = buildDirConfigs(PRESET_AGENT_DIRS, [])
    expect(configs).toHaveLength(PRESET_AGENT_DIRS.length)
    expect(configs.every(c => c.enabled === false)).toBe(true)
  })

  it('preset 成员即使不存在也保留为 enabled（推荐候选语义，防回归）', () => {
    // 回归场景：用户在 Settings 勾选启用了某 preset 路径（如 ~/.claude/skills），
    // 它被写入 discovery.json，但该目录在本机器不存在（未安装 Claude Code / 换机器 / 正准备创建）。
    // 修复前：step1 过滤掉它（不存在）+ step2 认为已启用不追加候选 → 从 UI 彻底消失，不可取消勾选。
    // 修复后：preset 成员豁免 existsSync，显示为 enabled，用户可管理。
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, ['~/.claude/skills'])
    const claudeEntry = configs.find(c => c.path === '~/.claude/skills')
    expect(claudeEntry).toBeTruthy()
    expect(claudeEntry!.enabled).toBe(true)
    // 其余 preset 仍追加为候选
    const otherPresets = configs.filter(c => c.path !== '~/.claude/skills')
    expect(otherPresets.every(c => c.enabled === false)).toBe(true)
    expect(otherPresets).toHaveLength(PRESET_SKILL_DIRS.length - 1)
  })
})

describe('discovery-store setSkillDirs 脏数据写入过滤（与 buildDirConfigs 对齐，ADR §5）', () => {
  // 本 describe 自带：真实存在的绝对路径样本 + 独立 discovery.json 路径，隔离落盘行为。
  let discoveryPath: string
  let discoveryTmpDir: string
  let realDir: string

  beforeEach(() => {
    discoveryTmpDir = mkdtempSync(join(tmpdir(), 'discovery-filter-'))
    discoveryPath = join(discoveryTmpDir, 'discovery.json')
    setDiscoveryPath(discoveryPath)
    realDir = mkdtempSync(join(tmpdir(), 'skill-real-'))
  })

  afterEach(() => {
    rmSync(discoveryTmpDir, { recursive: true, force: true })
    rmSync(realDir, { recursive: true, force: true })
  })

  it('剔除不存在的绝对路径脏数据（/path/a 等 pi 占位符），保留存在的', () => {
    setSkillDirs(['/path/a', '/path/b', realDir])
    expect(getSkillDirs()).toEqual([realDir])
  })

  it('preset 成员即使不存在也保留（推荐候选语义，豁免 existsSync）', () => {
    setSkillDirs(['~/.claude/skills', '~/.pi/agent/skills', '/path/a'])
    expect(getSkillDirs()).toEqual(['~/.claude/skills', '~/.pi/agent/skills'])
  })

  it('相对路径不检查存在性（无 cwd 上下文）', () => {
    setSkillDirs(['.agents/skills', '.xyz-agent/skills', '/path/a'])
    expect(getSkillDirs()).toEqual(['.agents/skills', '.xyz-agent/skills'])
  })

  it('~ 展开后存在的路径保留（确定性，不依赖测试机）', () => {
    const tmpHomeSubdir = mkdtempSync(join(homedir(), '.skill-settest-'))
    try {
      const tildePath = '~/' + basename(tmpHomeSubdir)
      setSkillDirs([tildePath, '/path/a'])
      expect(getSkillDirs()).toEqual([tildePath])
    } finally {
      rmSync(tmpHomeSubdir, { recursive: true, force: true })
    }
  })

  it('保留顺序（优先级语义，靠前覆盖靠后）', () => {
    setSkillDirs([realDir, '~/.claude/skills', '/path/a', '.agents/skills'])
    expect(getSkillDirs()).toEqual([realDir, '~/.claude/skills', '.agents/skills'])
  })
})
