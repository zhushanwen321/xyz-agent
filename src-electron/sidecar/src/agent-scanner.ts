import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ScannedAgentInfo, ScanSourceType } from '@xyz-agent/shared'

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function inferSourceType(path: string): ScanSourceType {
  if (path.includes('.pi/')) return 'pi'
  if (path.includes('.claude/')) return 'claude'
  if (path.includes('.agents/')) return 'agents'
  return 'custom'
}

function parseAgentMd(content: string): { description: string; tools: string[] } {
  const lines = content.split('\n')
  let description = ''
  const tools: string[] = []

  // 跳过 YAML frontmatter
  let inFrontmatter = false
  let frontmatterEnd = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true
        continue
      } else {
        frontmatterEnd = i + 1
        break
      }
    }
  }

  for (let i = frontmatterEnd; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('#')) continue
    description = line.slice(0, 200)
    break
  }

  return { description, tools }
}

export function scanAgents(sources: string[], existingAgentIds: Set<string>): ScannedAgentInfo[] {
  const results: ScannedAgentInfo[] = []

  for (const rawSource of sources) {
    const source = expandHome(rawSource)
    const sourceType = inferSourceType(rawSource)

    if (!existsSync(source)) continue
    let entries
    try {
      entries = readdirSync(source, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirPath = join(source, entry.name)

      // 查找主配置文件：优先 agent.md，备选目录名.md 或 SKILL.md
      const candidates = ['agent.md', `${entry.name}.md`, 'SKILL.md']
      let configPath: string | null = null
      let content = ''

      for (const c of candidates) {
        const p = join(dirPath, c)
        if (existsSync(p)) {
          configPath = p
          try { content = readFileSync(p, 'utf-8') } catch { continue }
          break
        }
      }

      if (!configPath) continue

      try {
        const { description, tools } = parseAgentMd(content)
        const id = `${sourceType}-${entry.name}`
        const alreadyImported = existingAgentIds.has(id)

        results.push({
          id,
          name: entry.name,
          description,
          sourceType,
          sourcePath: configPath,
          content,
          icon: entry.name.charAt(0).toUpperCase(),
          tools,
          alreadyImported,
        })
      } catch {
        // skip unreadable
      }
    }
  }

  return results
}
