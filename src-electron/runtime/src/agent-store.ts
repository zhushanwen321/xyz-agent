import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentInfo } from '@xyz-agent/shared'

const JSON_INDENT = 2

export function loadAgents(projectRoot: string): AgentInfo[] {
  const dir = join(projectRoot, '.xyz-agent')
  const path = join(dir, 'agents.json')
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8')
      return JSON.parse(raw) as AgentInfo[]
    }
  // eslint-disable-next-line taste/no-silent-catch -- intentional: missing agents file returns empty list
  } catch (e) {
    console.error('[config] load agents error:', e)
  }
  return []
}

export function saveAgents(projectRoot: string, agents: AgentInfo[]): void {
  try {
    const dir = join(projectRoot, '.xyz-agent')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agents.json'), JSON.stringify(agents, null, JSON_INDENT))
  // eslint-disable-next-line taste/no-silent-catch -- intentional: save failure is best-effort
  } catch (e) {
    console.error('[config] save agents error:', e)
  }
}
