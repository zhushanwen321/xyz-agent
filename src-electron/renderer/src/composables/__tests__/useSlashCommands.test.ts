import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSlashCommands } from '../useSlashCommands'
import type { SkillInfo } from '@xyz-agent/shared'

/**
 * AgentInfo 类型 — 目前尚未定义于 shared/src 中。
 * 实现 agent 需要在 shared 中新增此接口，并在 useSlashCommands 中支持。
 */
interface AgentInfo {
  id: string
  name: string
  description: string
  enabled: boolean
}

/**
 * 工厂函数
 */
function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
  id: 'skill-1',
  name: 'test-skill',
  description: 'A test skill',
  enabled: true,
  source: 'local',
  ...overrides,
  }
}

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
  id: 'agent-1',
  name: 'reviewer',
  description: 'A test agent',
  enabled: true,
  ...overrides,
  }
}

describe('useSlashCommands — agent command support', () => {
  let slash: ReturnType<typeof useSlashCommands>

  beforeEach(() => {
  // useSlashCommands 模块级单例 (defaultsInitialized) 需要在每个测试前重置。
  // 当前实现没有 reset 方法，测试中通过 vi.resetModules 来隔离。
  // 但因为 import 是静态的，我们利用 initDefaultCommands 的幂等性。
  slash = useSlashCommands()
  slash.initDefaultCommands()
  })

  // ── 1. agent 命令应被包含 ──────────────────────────────────────

  it('should include agent commands when agents are provided', () => {
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'code-reviewer', description: 'Reviews code' }),
  ]

  // 新签名: mergeSkillCommands(skills, agents)
  // 当前只有单参数签名，这行会 TS 编译失败或运行时缺少 agent 命令
  const result = slash.mergeSkillCommands([], agents as any)

  const agentCmd = result.find(c => c.name === 'agent:code-reviewer')
  expect(agentCmd).toBeDefined()
  expect(agentCmd!.source).toBe('agent')
  expect(agentCmd!.action).toEqual({ type: 'agent', agentName: 'code-reviewer' })
  expect(agentCmd!.description).toBe('Reviews code')
  })

  // ── 2. 仅包含 enabled 的 agent ─────────────────────────────────

  it('should only include enabled agents', () => {
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'enabled-agent', description: 'On', enabled: true }),
    makeAgent({ id: 'a2', name: 'disabled-agent', description: 'Off', enabled: false }),
  ]

  const result = slash.mergeSkillCommands([], agents as any)

  expect(result.some(c => c.name === 'agent:enabled-agent')).toBe(true)
  expect(result.some(c => c.name === 'agent:disabled-agent')).toBe(false)
  })

  // ── 3. agent action 使用 agent source 和 agentName ─────────────

  it('should use agent source type and agent name in action', () => {
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'refactor', description: 'Refactors code' }),
  ]

  const result = slash.mergeSkillCommands([], agents as any)
  const cmd = result.find(c => c.name === 'agent:refactor')

  expect(cmd).toBeDefined()
  // source 应为 'agent'（需要 SlashCommandSource 扩展）
  expect(cmd!.source).toBe('agent')
  // action 应为 { type: 'agent', agentName: 'refactor' }
  expect(cmd!.action).toEqual({ type: 'agent', agentName: 'refactor' })
  })

  // ── 4. 去重：agent 与 builtin/skill 同名时保持首个 ─────────────

  it('should deduplicate when agent name matches builtin or skill name', () => {
  // builtin 已有 'clear', 'compact', 'help'
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'clear', description: 'Skill clear', enabled: true }),
  ]
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'clear', description: 'Agent clear', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills, agents as any)
  const clearCmds = result.filter(c => c.name === 'clear')

  // 去重后只有一个 'clear'，且优先级 builtin > skill > agent
  expect(clearCmds.length).toBe(1)
  expect(clearCmds[0].source).toBe('builtin')
  })

  // ── 5. 三种来源排序 ─────────────────────────────────────────────

  it('should sort all commands from all three sources alphabetically', () => {
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'zebra-skill', description: 'Z skill', enabled: true }),
  ]
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'alpha-agent', description: 'A agent', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills, agents as any)

  // 检查排序
  const names = result.map(c => c.name)
  for (let i = 1; i < names.length; i++) {
    expect(names[i - 1].localeCompare(names[i])).toBeLessThanOrEqual(0)
  }

  // agent:alpha-agent 应排在前面（a 开头）
  expect(names[0]).toBe('agent:alpha-agent')
  })

  // ── 6. 空 agents 数组的向后兼容 ─────────────────────────────────

  it('should work with empty agents array (backward compat)', () => {
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'my-skill', description: 'A skill', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills, [] as any)

  // 应仍然包含 builtin + skill
  expect(result.some(c => c.source === 'builtin')).toBe(true)
  expect(result.some(c => c.name === 'my-skill')).toBe(true)
  // 没有 agent 命令
  expect(result.every(c => c.source !== 'agent')).toBe(true)
  })

  // ── 7. 只传 skills 的向后兼容 ───────────────────────────────────

  it('should not break when only skills are provided (backward compat)', () => {
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'solo-skill', description: 'Solo', enabled: true }),
  ]

  // 只传一个参数 — 既单参数签名仍应工作
  const result = slash.mergeSkillCommands(skills)

  expect(result.some(c => c.name === 'solo-skill')).toBe(true)
  expect(result.some(c => c.source === 'builtin')).toBe(true)
  })
})
