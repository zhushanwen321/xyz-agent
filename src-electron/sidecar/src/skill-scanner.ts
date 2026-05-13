import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ScannedSkillInfo, ScanSourceType } from '@xyz-agent/shared'

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function inferSourceType(path: string): ScanSourceType {
  if (path.includes('.pi/')) return 'pi'
  if (path.includes('.claude/')) return 'claude'
  if (path.includes('.agents/')) return 'agents'
  return 'custom'
}

function parseSkillMd(content: string): { description: string; triggers: string[] } {
  const lines = content.split('\n')
  let description = ''
  const triggers: string[] = []

  // 跳过 YAML frontmatter (--- ... ---)
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

  // 从 frontmatter 后的第一个非标题、非空行开始取 description
  for (let i = frontmatterEnd; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('#')) continue
    description = line.slice(0, 200)
    break
  }

  // triggers: 尝试从 frontmatter 或 description 字段附近找
  // 宽容处理，找不到就留空
  return { description, triggers }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function scanSkills(sources: string[], existingSkillIds: Set<string>): ScannedSkillInfo[] {
  const results: ScannedSkillInfo[] = []

  for (const rawSource of sources) {
    const source = expandHome(rawSource)
    const sourceType = inferSourceType(rawSource)

    if (!existsSync(source)) continue
    let names
    try {
      names = readdirSync(source)
    } catch {
      continue
    }

    for (const name of names) {
      const dirPath = join(source, name)
      // statSync 跟随符号链接，正确处理 symlinked skill 目录
      try {
        if (!statSync(dirPath).isDirectory()) continue
      } catch {
        continue
      }
      const skillMdPath = join(dirPath, 'SKILL.md')

      if (!existsSync(skillMdPath)) continue

      try {
        const content = readFileSync(skillMdPath, 'utf-8')
        const { description, triggers } = parseSkillMd(content)
        const stat = statSync(skillMdPath)
        const id = `${sourceType}-${name}`
        const alreadyImported = existingSkillIds.has(id)

        results.push({
          id,
          name: name,
          description,
          sourceType,
          sourcePath: skillMdPath,
          triggers,
          content,
          fileSize: formatFileSize(stat.size),
          tools: [],
          alreadyImported,
        })
      } catch {
        // skip unreadable files
      }
    }
  }

  return results
}
