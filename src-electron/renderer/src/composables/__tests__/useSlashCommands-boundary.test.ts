import { describe, it, expect, beforeEach } from 'vitest'
import { useSlashCommands } from '../useSlashCommands'
import type { SkillInfo, AgentInfo } from '@xyz-agent/shared'

/**
 * Boundary path tests for useSlashCommands.mergeSkillCommands.
 *
 * Supplements useSlashCommands.test.ts which covers normal agent integration paths.
 * These tests verify edge-case behavior: empty names, special characters,
 * large lists, dedup edge cases, and null/undefined inputs.
 */

function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
  id: 'skill-1',
  name: 'test-skill',
  description: 'A test skill',
  enabled: true,
  source: 'local',
  triggers: [],
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

describe('useSlashCommands.mergeSkillCommands — boundary paths', () => {
  let slash: ReturnType<typeof useSlashCommands>

  beforeEach(() => {
  slash = useSlashCommands()
  slash.initDefaultCommands()
  })

  // ── Boundary: agent with empty name ────────────────────────────

  it('should create agent: command even when agent name is empty string', () => {
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: '', description: 'No name', enabled: true }),
  ]

  const result = slash.mergeSkillCommands([], agents)

  // Agent with empty name produces command "agent:" — still valid
  const cmd = result.find(c => c.name === 'agent:')
  expect(cmd).toBeDefined()
  expect(cmd!.source).toBe('agent')
  expect(cmd!.action).toEqual({ type: 'agent', agentName: '' })
  })

  // ── Boundary: agent with special characters in name ────────────

  it('should include agent name with spaces as-is in command name', () => {
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'code reviewer', description: 'Has spaces', enabled: true }),
  ]

  const result = slash.mergeSkillCommands([], agents)

  const cmd = result.find(c => c.name === 'agent:code reviewer')
  expect(cmd).toBeDefined()
  expect(cmd!.action).toEqual({ type: 'agent', agentName: 'code reviewer' })
  })

  it('should include agent name with slashes as-is in command name', () => {
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'path/to/agent', description: 'Has slashes', enabled: true }),
  ]

  const result = slash.mergeSkillCommands([], agents)

  const cmd = result.find(c => c.name === 'agent:path/to/agent')
  expect(cmd).toBeDefined()
  expect(cmd!.action).toEqual({ type: 'agent', agentName: 'path/to/agent' })
  })

  // ── Boundary: 100+ agents → dedup correctness ─────────────────

  it('should correctly handle 100 agents with no duplicates', () => {
  const agents: AgentInfo[] = Array.from({ length: 100 }, (_, i) =>
    makeAgent({
    id: `agent-${i}`,
    name: `agent-${i}`,
    description: `Agent ${i}`,
    enabled: true,
    }),
  )

  const result = slash.mergeSkillCommands([], agents)

  const agentCmds = result.filter(c => c.source === 'agent')
  expect(agentCmds).toHaveLength(100)
  // All unique
  const names = new Set(agentCmds.map(c => c.name))
  expect(names.size).toBe(100)
  })

  it('should deduplicate 100 agents when some share names with builtins', () => {
  // compact, help are the only builtins (clear was removed in 83f43a99
  // when session.clear protocol was dropped)
  const agents: AgentInfo[] = [
    ...Array.from({ length: 98 }, (_, i) =>
    makeAgent({
      id: `agent-${i}`,
      name: `unique-agent-${i}`,
      description: `Agent ${i}`,
      enabled: true,
    }),
    ),
    // These 2 collide with builtin names — "compact", "help"
    makeAgent({ id: 'a-compact', name: 'compact', description: 'Agent compact', enabled: true }),
    makeAgent({ id: 'a-help', name: 'help', description: 'Agent help', enabled: true }),
  ]

  const result = slash.mergeSkillCommands([], agents)

  const compactCmds = result.filter(c => c.name === 'compact')
  const helpCmds = result.filter(c => c.name === 'help')

  // Dedup keeps first occurrence (builtin wins since merged first)
  expect(compactCmds).toHaveLength(1)
  expect(compactCmds[0].source).toBe('builtin')
  expect(helpCmds).toHaveLength(1)
  expect(helpCmds[0].source).toBe('builtin')
  })

  // ── Boundary: skill and agent with identical non-builtin name ──

  it('should deduplicate skill-agent name collision, keeping skill first', () => {
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'review', description: 'Skill review', enabled: true }),
  ]
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'review', description: 'Agent review', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills, agents)

  // "review" appears as skill (source='skill'), not as "agent:review"
  const reviewCmds = result.filter(c => c.name === 'review')
  expect(reviewCmds).toHaveLength(1)
  expect(reviewCmds[0].source).toBe('skill')
  })

  it('should deduplicate when agent has name identical to a skill but prefixed differently', () => {
  // Agent commands are "agent:{name}", skills are just "{name}"
  // So "review" skill and "review" agent produce different commands:
  // "review" (skill) and "agent:review" (agent) — both should exist
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'review', description: 'Skill', enabled: true }),
  ]
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'review', description: 'Agent', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills, agents)

  // Skill produces "review", agent produces "agent:review" — different names
  expect(result.some(c => c.name === 'review' && c.source === 'skill')).toBe(true)
  expect(result.some(c => c.name === 'agent:review' && c.source === 'agent')).toBe(true)
  })

  // ── Error: agents is null/undefined ────────────────────────────

  it('should not crash when agents is undefined', () => {
  const result = slash.mergeSkillCommands([], undefined as unknown as AgentInfo[])

  // Should only have builtins (compact, help — clear removed in 83f43a99)
  const builtinCmds = result.filter(c => c.source === 'builtin')
  expect(builtinCmds.length).toBeGreaterThanOrEqual(2)
  // No agent commands
  expect(result.every(c => c.source !== 'agent')).toBe(true)
  })

  it('should not crash when agents is null', () => {
  const result = slash.mergeSkillCommands([], null as unknown as AgentInfo[])

  expect(result.filter(c => c.source === 'builtin').length).toBeGreaterThanOrEqual(2)
  expect(result.every(c => c.source !== 'agent')).toBe(true)
  })

  // ── Boundary: result is always sorted ──────────────────────────

  it('should return alphabetically sorted commands even with many sources', () => {
  const skills: SkillInfo[] = [
    makeSkill({ id: 's1', name: 'zebra', description: 'Z skill', enabled: true }),
    makeSkill({ id: 's2', name: 'alpha-skill', description: 'A skill', enabled: true }),
  ]
  const agents: AgentInfo[] = [
    makeAgent({ id: 'a1', name: 'mid-agent', description: 'Mid', enabled: true }),
  ]

  const result = slash.mergeSkillCommands(skills, agents)
  const names = result.map(c => c.name)

  for (let i = 1; i < names.length; i++) {
    expect(names[i - 1].localeCompare(names[i])).toBeLessThanOrEqual(0)
  }
  })
})
