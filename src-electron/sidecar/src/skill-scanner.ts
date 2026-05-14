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

// 手写的 YAML frontmatter 解析，仅支持简单的 key: value 格式
// 不支持嵌套对象、引号内冒号、多行数组等复杂 YAML 场景
export function parseSkillMd(content: string): { description: string; triggers: string[]; argumentHint?: string } {
  const lines = content.split('\n')
  let description = ''
  const triggers: string[] = []

  // 提取 YAML frontmatter 内容
  const frontmatterLines: string[] = []
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
    if (inFrontmatter) frontmatterLines.push(lines[i])
  }

  // 从 frontmatter 中提取 description 字段（可能跨行）
  const fmDesc = frontmatterLines
    .join('\n')
    .match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim()

  // 正文 description：frontmatter 后第一个非标题、非空行
  for (let i = frontmatterEnd; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('#')) continue
    description = line.slice(0, 200)
    break
  }

  // 从 frontmatter 中提取 argument-hint 字段
  const argumentHint = frontmatterLines
  .join('\n')
  .match(/^argument-hint:\s*["']?(.+?)['"]?\s*$/m)?.[1]

  // 优先用 frontmatter description 提取 triggers（含触发词模式）
  const triggerSource = fmDesc ?? description
  const triggerPattern = /["\u201c]([^"\u201d\u2018\u2019]+?)["\u201d]/g
  let match: RegExpExecArray | null
  while ((match = triggerPattern.exec(triggerSource)) !== null) {
    const t = match[1].trim()
    if (t.length >= 2 && t.length <= 40) triggers.push(t)
  }

  return { description, triggers, argumentHint }
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
        const { description, triggers, argumentHint } = parseSkillMd(content)
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
      argumentHint,
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
