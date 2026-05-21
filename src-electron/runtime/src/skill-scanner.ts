import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ScannedSkillInfo } from '@xyz-agent/shared'
import { expandHome, inferSourceType } from './scanner-base.js'

const DESCRIPTION_MAX_LENGTH = 200
const TRIGGER_MIN_LENGTH = 2
const TRIGGER_MAX_LENGTH = 40
const BYTES_1KB = 1024
const BYTES_1MB = BYTES_1KB * BYTES_1KB

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

  // 从 frontmatter 中提取 description 字段（支持 "..." / '...' / 裸值）
  const fmDescMatch = frontmatterLines
    .join('\n')
    .match(/^description:\s*(?:"([^"]+)"|'([^']+)'|(.+?))\s*$/m)
  const fmDesc = fmDescMatch?.[1] ?? fmDescMatch?.[2] ?? fmDescMatch?.[3]?.trim()

  // 正文 description：frontmatter 后第一个非标题、非空行
  for (let i = frontmatterEnd; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('#')) continue
    description = line.slice(0, DESCRIPTION_MAX_LENGTH)
    break
  }

  // 从 frontmatter 中提取 argument-hint 字段（支持 "..." / '...' / 裸值）
  const hintRaw = frontmatterLines.join('\n')
    .match(/^argument-hint:\s*(?:"([^"]+)"|'([^']+)'|(.+?))\s*$/m)
  const argumentHint = hintRaw?.[1] ?? hintRaw?.[2] ?? hintRaw?.[3]?.trim()

  // 优先用 frontmatter description 提取 triggers（含触发词模式）
  const triggerSource = fmDesc ?? description
  const triggerPattern = /["\u201c]([^"\u201d\u2018\u2019]+?)["\u201d]/g
  let match: RegExpExecArray | null
  while ((match = triggerPattern.exec(triggerSource)) !== null) {
    const t = match[1].trim()
    if (t.length >= TRIGGER_MIN_LENGTH && t.length <= TRIGGER_MAX_LENGTH) triggers.push(t)
  }

  return { description, triggers, argumentHint }
}

function formatFileSize(bytes: number): string {
  if (bytes < BYTES_1KB) return `${bytes} B`
  if (bytes < BYTES_1MB) return `${(bytes / BYTES_1KB).toFixed(1)} KB`
  return `${(bytes / BYTES_1MB).toFixed(1)} MB`
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
      // eslint-disable-next-line taste/no-silent-catch -- intentional: skip unreadable skills, continue scanning
      } catch (e) {
        console.error(`[skill-scanner] error reading ${dirPath}:`, e)
      }
    }
  }

  return results
}
