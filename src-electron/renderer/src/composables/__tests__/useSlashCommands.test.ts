import { describe, it, expect, beforeEach } from 'vitest'
import { useSlashCommands } from '../useSlashCommands'
import type { SkillInfo, AgentInfo } from '@xyz-agent/shared'

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
  modelStrategy: 'auto',
  ...overrides,
  }
}

describe('useSlashCommands — agent command support', () => {
  let slash: ReturnType<typeof useSlashCommands>

  beforeEach(() => {
  slash = useSlashCommands()
  slash.initDefaultCommands()
  })

  it('should include agent commands when agents are provided', () => {
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'code-reviewer', description: 'Reviews code' }),
  ]

  const result = slash.mergeSkillCommands([], agents)

  const agentCmd = result.find(c => c.name === 'agent:code-reviewer')
  expect(agentCmd).toBeDefined()
  expect(agentCmd!.source).toBe('agent')
  expect(agentCmd!.action).toEqual({ type: 'agent', agentName: 'code-reviewer' })
  expect(agentCmd!.description).toBe('Reviews code')
  })

  it('should only include enabled agents', () => {
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'enabled-agent', description: 'On', enabled: true }),
    makeAgent({ id: 'a2', name: 'disabled-agent', description: 'Off', enabled: false }),
  ]

  const result = slash.mergeSkillCommands([], agents)

  expect(result.some(c => c.name === 'agent:enabled-agent')).toBe(true)
  expect(result.some(c => c.name === 'agent:disabled-agent')).toBe(false)
  })

  it('should use agent source type and agent name in action', () => {
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'refactor', description: 'Refactors code' }),
  ]

  const result = slash.mergeSkillCommands([], agents)
  const cmd = result.find(c => c.name === 'agent:refactor')

  expect(cmd).toBeDefined()
  expect(cmd!.source).toBe('agent')
  expect(cmd!.action).toEqual({ type: 'agent', agentName: 'refactor' })
  })

  it('should deduplicate when agent name matches builtin or skill name', () => {
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'clear', description: 'Skill clear', enabled: true }),
  ]
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'clear', description: 'Agent clear', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills, agents)
  const clearCmds = result.filter(c => c.name === 'clear')

  expect(clearCmds.length).toBe(1)
  expect(clearCmds[0].source).toBe('builtin')
  })

  it('should sort all commands from all three sources alphabetically', () => {
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'zebra-skill', description: 'Z skill', enabled: true }),
  ]
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'alpha-agent', description: 'A agent', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills, agents)

  const names = result.map(c => c.name)
  for (let i = 1; i < names.length; i++) {
    expect(names[i - 1].localeCompare(names[i])).toBeLessThanOrEqual(0)
  }

  expect(names[0]).toBe('agent:alpha-agent')
  })

  it('should work with empty agents array (backward compat)', () => {
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'my-skill', description: 'A skill', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills, [])

  expect(result.some(c => c.source === 'builtin')).toBe(true)
  expect(result.some(c => c.name === 'my-skill')).toBe(true)
  expect(result.every(c => c.source !== 'agent')).toBe(true)
  })

  it('should not break when only skills are provided (backward compat)', () => {
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'solo-skill', description: 'Solo', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills)

  expect(result.some(c => c.name === 'solo-skill')).toBe(true)
  expect(result.some(c => c.source === 'builtin')).toBe(true)
  })
})
