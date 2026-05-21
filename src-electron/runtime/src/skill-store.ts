import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillInfo } from '@xyz-agent/shared'

const JSON_INDENT = 2

export function loadSkills(projectRoot: string): SkillInfo[] {
  const dir = join(projectRoot, '.xyz-agent')
  const path = join(dir, 'skills.json')
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8')
      return JSON.parse(raw) as SkillInfo[]
    }
  // eslint-disable-next-line taste/no-silent-catch -- intentional: missing skills file returns empty list
  } catch (e) {
    console.error('[config] load skills error:', e)
  }
  return []
}

export function saveSkills(projectRoot: string, skills: SkillInfo[]): void {
  try {
    const dir = join(projectRoot, '.xyz-agent')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'skills.json'), JSON.stringify(skills, null, JSON_INDENT))
  // eslint-disable-next-line taste/no-silent-catch -- intentional: save failure is best-effort
  } catch (e) {
    console.error('[config] save skills error:', e)
  }
}
